function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';

  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .substring(0, 5000)
    .trim();
}

function extractMainKeywords(text) {
  const cleaned = sanitizeInput(text).substring(0, 1000);
  const keywords = [];

  try {
    const namedEntities = cleaned.match(/\b[A-Z][a-zA-ZÀ-ÿ]+(?:\s+[A-Z][a-zA-ZÀ-ÿ]+){0,2}\b/g) || [];
    keywords.push(...namedEntities.slice(0, 4));

    const dates = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
    keywords.push(...dates.slice(0, 2));

    const numbersWithUnits = cleaned.match(/\b\d+([,\.]\d+)?\s*(?:million|milliard|%|km|habitants|meters)\b/gi) || [];
    keywords.push(...numbersWithUnits.slice(0, 2));

    const significantWords = cleaned.match(/\b[a-zA-ZÀ-ÿ]{5,15}\b/g) || [];
    keywords.push(...significantWords.slice(0, 3));

    return [...new Set(keywords)].filter((k) => k && k.length > 2).slice(0, 6);
  } catch (error) {
    console.error('Erreur extraction keywords:', error.message);
    return [];
  }
}

module.exports = {
  sanitizeInput,
  extractMainKeywords,
};
