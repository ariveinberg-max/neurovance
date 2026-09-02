import { db } from '../src/db.js';
import { getEmbedding } from '../src/embeddings.js';

async function backfill() {
  console.log('Starting embedding backfill...');

  const usersSnap = await db.collection('users').get();
  const users = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  console.log(`Found ${users.length} users.`);

  for (const user of users) {
    console.log(`Processing user ${user.id}...`);
    const memoriesSnap = await db.collection(`users/${user.id}/memories`).get();
    const memories = memoriesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    console.log(`  Found ${memories.length} memories.`);

    for (const memory of memories) {
      if (memory.embedding) {
        console.log(`  Memory ${memory.id} already has embedding, skipping.`);
        continue;
      }

      try {
        const embedding = await getEmbedding(memory.content, 'document');
        await db.collection(`users/${user.id}/memories`).doc(memory.id).update({
          embedding,
        });
        console.log(`  Updated memory ${memory.id}.`);
      } catch (e) {
        console.error(`  Failed to embed memory ${memory.id}:`, e);
      }
    }
  }

  console.log('Backfill complete!');
}

backfill().catch(console.error);
