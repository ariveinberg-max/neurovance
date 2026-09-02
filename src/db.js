import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

export const db = getFirestore(app);

// Write-through in-process cache — eliminates repeated Firestore reads for
// the same document within a request chain (user doc gets read 2-3x per chat
// message otherwise). TTL is just a safety net; writes invalidate immediately.
const cache = new Map();
const CACHE_TTL_MS = 60_000;

function cacheKey(collectionPath, docId) {
  return `${collectionPath}\0${docId}`;
}

function collCacheKey(collectionPath) {
  return `${collectionPath}\0COLLECTION`;
}

export async function getDoc(collectionPath, docId) {
  const key = cacheKey(collectionPath, docId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  const snap = await db.collection(collectionPath).doc(String(docId)).get();
  const data = snap.exists ? snap.data() : null;
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

export async function setDoc(collectionPath, docId, data) {
  await db.collection(collectionPath).doc(String(docId)).set(data);
  cache.set(cacheKey(collectionPath, docId), { data, expiresAt: Date.now() + CACHE_TTL_MS });
  cache.delete(collCacheKey(collectionPath));
}

export async function deleteDoc(collectionPath, docId) {
  await db.collection(collectionPath).doc(String(docId)).delete();
  cache.delete(cacheKey(collectionPath, docId));
  cache.delete(collCacheKey(collectionPath));
}

export async function getAllDocs(collectionPath) {
  const key = collCacheKey(collectionPath);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  const snap = await db.collection(collectionPath).get();
  const data = snap.docs.map((d) => d.data());
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

export async function queryDocsByField(collectionPath, field, value) {
  const snap = await db.collection(collectionPath).where(field, '==', value).get();
  return snap.docs.map((d) => d.data());
}

export async function queryDocsByTwoFields(collectionPath, field1, value1, field2, value2) {
  const snap = await db.collection(collectionPath)
    .where(field1, '==', value1)
    .where(field2, '==', value2)
    .get();
  return snap.docs.map((d) => d.data());
}

export async function vectorSearch(collectionPath, queryVector, limit = 10) {
  const snap = await db.collection(collectionPath).findNearest({
    vectorField: 'embedding',
    queryVector: queryVector,
    distanceMeasure: 'COSINE',
    limit,
  }).get();
  return snap.docs.map((d) => d.data());
}

export async function runTransaction(collectionPath, docId, updateFn) {
  const docRef = db.collection(collectionPath).doc(String(docId));
  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(docRef);
    const data = snap.exists ? snap.data() : null;
    const result = await updateFn(data);
    if (Array.isArray(result)) {
      const [savedData, returnedResult] = result;
      if (savedData && typeof savedData === 'object') {
        transaction.set(docRef, savedData, { merge: true });
      }
      return returnedResult;
    } else if (result && typeof result === 'object') {
      transaction.set(docRef, result, { merge: true });
      return result;
    }
    return result;
  });
  // A transaction writes directly to Firestore, bypassing setDoc — so it never
  // invalidated the cache. Without this, getDoc/getAllDocs keep serving the
  // stale pre-transaction doc (e.g. a tokenUsage increment) for up to the TTL,
  // which made checkTokenUsage's budget check forget that usage had been
  // consumed and let a run exceed its daily cap.
  cache.delete(cacheKey(collectionPath, docId));
  cache.delete(collCacheKey(collectionPath));
  return result;
}

// Bounded reads. getAllDocs pulls (and is billed for) every document in the
// collection, which is what put the free-tier read quota on the floor — a
// user with 4k memories paid 4k reads just to find the 5 most recent. These
// push the filtering into Firestore so the bill matches what's actually used.

export async function queryOrdered(collectionPath, field, direction, limit) {
  const snap = await db.collection(collectionPath).orderBy(field, direction).limit(limit).get();
  return snap.docs.map((d) => d.data());
}

export async function queryWhereOrdered(collectionPath, field, op, value, orderField, direction, limit) {
  const snap = await db.collection(collectionPath)
    .where(field, op, value)
    .orderBy(orderField, direction)
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data());
}

export async function queryArrayContains(collectionPath, field, value) {
  const snap = await db.collection(collectionPath).where(field, 'array-contains', value).get();
  return snap.docs.map((d) => d.data());
}
