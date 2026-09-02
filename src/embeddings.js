const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const VOYAGE_MODEL = 'voyage-4';

/**
 * Generate a vector embedding for the given text using Voyage AI.
 * @param {string} text The text to embed.
 * @param {'document' | 'query'} type The input type: 'document' for storage, 'query' for search.
 * @returns {Promise<number[]>} The resulting embedding vector.
 */
export async function getEmbedding(text, type = 'document') {
  if (!VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY is not defined in the environment.');
  }

  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: text,
      model: VOYAGE_MODEL,
      input_type: type,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Voyage AI API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // Voyage returns an array of embeddings for the inputs provided.
  // Since we provide a single string, we take the first result.
  if (!data.data || data.data.length === 0) {
    throw new Error('Voyage AI API returned no embeddings.');
  }

  return data.data[0].embedding;
}
