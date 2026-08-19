import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Real persistence — local memory/*.json files get wiped every time this
// app redeploys (no persistent disk attached to the host), which was
// silently resetting every account, session, and memory on every push.
// Firestore lives on its own separate infrastructure, so redeploying this
// app has zero effect on data stored here.
const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Firebase's own downloaded key uses real newlines in a quoted .env
    // value; this is defense in depth in case it ever arrives with escaped
    // "\n" sequences instead (e.g. pasted through a tool that doesn't
    // preserve real line breaks).
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

export const db = getFirestore(app);

export async function getDoc(collectionPath, docId) {
  const snap = await db.collection(collectionPath).doc(docId).get();
  return snap.exists ? snap.data() : null;
}

export async function setDoc(collectionPath, docId, data) {
  await db.collection(collectionPath).doc(docId).set(data);
}

export async function deleteDoc(collectionPath, docId) {
  await db.collection(collectionPath).doc(docId).delete();
}

export async function getAllDocs(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  return snap.docs.map((d) => d.data());
}
