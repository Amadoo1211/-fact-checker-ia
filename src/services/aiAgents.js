class AIAgentsService {
  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY;
    this.model = 'gpt-4o-mini';
  }

  async callOpenAI(systemPrompt, userPrompt, maxTokens = 500) {
    if (!this.apiKey) {
      console.warn('OpenAI API key manquante - Agent désactivé');
      return null;
    }

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (error) {
      console.error('Erreur appel OpenAI:', error.message);
      return null;
    }
  }

  async factChecker(text, sources) {
    const systemPrompt = `You are an expert fact-checker. Analyze the text and identify:
1. VERIFIED claims (with proof from sources)
2. UNVERIFIED/FALSE claims (with explanation why)
3. Overall confidence score (0-100)

Return ONLY valid JSON:
{
  "score": 75,
  "verified_claims": [
    {"claim": "exact quote", "status": "verified", "source": "source name", "confidence": 95}
  ],
  "unverified_claims": [
    {"claim": "exact quote", "status": "false", "reason": "why it's false or unverified"}
  ],
  "summary": "brief overall assessment"
}`;

    const sourcesText = sources.slice(0, 3).map((s) => `Source: ${s.title}\nURL: ${s.url}\n${s.snippet || ''}\nContent: ${s.content?.substring(0, 800) || ''}`).join('\n\n---\n\n');

    const userPrompt = `Analyze this text and extract specific claims:

TEXT TO VERIFY:
"${text.substring(0, 1200)}"

SOURCES AVAILABLE:
${sourcesText}

Identify specific factual claims (statistics, dates, names, events) and verify each one against the sources. Return JSON only.`;

    const result = await this.callOpenAI(systemPrompt, userPrompt, 700);

    if (!result) {
      return {
        score: 50,
        verified_claims: [],
        unverified_claims: [{ claim: 'Analysis unavailable', status: 'unavailable', reason: 'OpenAI API not configured' }],
        summary: 'Agent unavailable',
      };
    }

    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.verified_claims) parsed.verified_claims = [];
        if (!parsed.unverified_claims) parsed.unverified_claims = [];
        if (!parsed.score) parsed.score = 50;
        return parsed;
      }
      return {
        score: 50,
        verified_claims: [],
        unverified_claims: [{ claim: result.substring(0, 150), status: 'error', reason: 'Could not parse response' }],
        summary: 'Parsing error',
      };
    } catch (error) {
      console.error('Parse error fact_checker:', error);
      return {
        score: 50,
        verified_claims: [],
        unverified_claims: [{ claim: 'Parse error', status: 'error', reason: error.message }],
        summary: 'Error',
      };
    }
  }

  async sourceAnalyst(text, sources) {
    const systemPrompt = `You are a source credibility analyst. For each source provided, determine:
1. If it's a REAL source (exists and is credible)
2. If it's a FAKE/INVENTED source (doesn't exist or is unreliable)
3. Overall source quality score (0-100)

Return ONLY valid JSON:
{
  "score": 80,
  "real_sources": [
    {"citation": "source name", "status": "verified", "url": "url", "credibility": "high/medium/low"}
  ],
  "fake_sources": [
    {"citation": "source name", "status": "not_found", "reason": "why it's fake"}
  ],
  "summary": "brief assessment"
}`;

    const sourcesText = sources.map((s) => `Title: ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet || ''}\nContent: ${s.content?.substring(0, 400) || ''}`).join('\n\n---\n\n');

    const userPrompt = `Analyze these sources and determine if they are real and credible:

TEXT CONTEXT:
"${text.substring(0, 600)}"

SOURCES TO ANALYZE:
${sourcesText}

Check if sources actually exist, are credible, and support the claims. Return JSON only.`;

    const result = await this.callOpenAI(systemPrompt, userPrompt, 600);

    if (!result) {
      return {
        score: 50,
        real_sources: sources.map((s) => ({ citation: s.title, status: 'unknown', url: s.url, credibility: 'unknown' })),
        fake_sources: [],
        summary: 'Agent unavailable',
      };
    }

    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.real_sources) parsed.real_sources = [];
        if (!parsed.fake_sources) parsed.fake_sources = [];
        if (!parsed.score) parsed.score = 50;
        return parsed;
      }
      return {
        score: 50,
        real_sources: [],
        fake_sources: [{ citation: 'Parse error', status: 'error', reason: 'Could not parse response' }],
        summary: 'Error',
      };
    } catch (error) {
      console.error('Parse error source_analyst:', error);
      return {
        score: 50,
        real_sources: [],
        fake_sources: [{ citation: 'Error', status: 'error', reason: error.message }],
        summary: 'Error',
      };
    }
  }

  async contextGuardian(text, sources) {
    const systemPrompt = `You are a context analysis expert. Identify what important information is MISSING or OMITTED from the text:
1. Missing temporal context (dates, timeframes)
2. Missing geographic context
3. Missing important facts
4. Context manipulation score (0-100, where 0 = complete, 100 = heavily manipulated)

Return ONLY valid JSON:
{
  "context_score": 25,
  "omissions": [
    {"type": "temporal/geographic/fact", "description": "what's missing", "importance": "critical/important/minor"}
  ],
  "manipulation_detected": true/false,
  "summary": "brief assessment"
}`;

    const sourcesText = sources.slice(0, 3).map((s) => s.content?.substring(0, 400) || s.snippet || '').join('\n');

    const userPrompt = `Analyze what's MISSING from this text:

TEXT:
"${text.substring(0, 1200)}"

SOURCES FOR CONTEXT:
${sourcesText}

What important information is omitted? What context is missing? Return JSON only.`;

    const result = await this.callOpenAI(systemPrompt, userPrompt, 500);

    if (!result) {
      return {
        context_score: 50,
        omissions: [{ type: 'unknown', description: 'Analysis unavailable', importance: 'unknown' }],
        manipulation_detected: false,
        summary: 'Agent unavailable',
      };
    }

    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.omissions) parsed.omissions = [];
        if (!parsed.context_score) parsed.context_score = 50;
        if (parsed.manipulation_detected === undefined) parsed.manipulation_detected = false;
        return parsed;
      }
      return {
        context_score: 50,
        omissions: [{ type: 'error', description: 'Parse error', importance: 'unknown' }],
        manipulation_detected: false,
        summary: 'Error',
      };
    } catch (error) {
      console.error('Parse error context_guardian:', error);
      return {
        context_score: 50,
        omissions: [{ type: 'error', description: error.message, importance: 'unknown' }],
        manipulation_detected: false,
        summary: 'Error',
      };
    }
  }

  async freshnessDetector(text, sources) {
    const systemPrompt = `You are a data freshness analyst. Identify:
1. Recent data (< 6 months old)
2. Outdated data (> 18 months old)
3. Freshness score (0-100, where 100 = very recent)

Return ONLY valid JSON:
{
  "freshness_score": 60,
  "recent_data": [
    {"data_point": "what is recent", "age": "how recent", "source": "which source"}
  ],
  "outdated_data": [
    {"data_point": "what is outdated", "age": "how old", "concern": "why it matters"}
  ],
  "summary": "brief assessment"
}`;

    const sourcesText = sources.slice(0, 3).map((s) => `${s.title}\n${s.content?.substring(0, 400) || s.snippet || ''}`).join('\n\n');

    const userPrompt = `Determine how recent and relevant the data is in this text:

TEXT:
"${text.substring(0, 800)}"

SOURCES:
${sourcesText}

List fresh vs outdated data. Return JSON only.`;

    const result = await this.callOpenAI(systemPrompt, userPrompt, 500);

    if (!result) {
      return {
        freshness_score: 50,
        recent_data: [],
        outdated_data: [{ data_point: 'Analysis unavailable', age: 'unknown', concern: 'OpenAI API not configured' }],
        summary: 'Agent unavailable',
      };
    }

    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.recent_data) parsed.recent_data = [];
        if (!parsed.outdated_data) parsed.outdated_data = [];
        if (!parsed.freshness_score) parsed.freshness_score = 50;
        return parsed;
      }
      return {
        freshness_score: 50,
        recent_data: [],
        outdated_data: [{ data_point: 'Parse error', age: 'unknown', concern: 'Could not parse' }],
        summary: 'Error',
      };
    } catch (error) {
      console.error('Parse error freshness_detector:', error);
      return {
        freshness_score: 50,
        recent_data: [],
        outdated_data: [{ data_point: 'Error', age: 'unknown', concern: error.message }],
        summary: 'Error',
      };
    }
  }

  async runAllAgents(text, sources) {
    const [factCheck, sourceAnalysis, contextAnalysis, freshnessAnalysis] = await Promise.all([
      this.factChecker(text, sources),
      this.sourceAnalyst(text, sources),
      this.contextGuardian(text, sources),
      this.freshnessDetector(text, sources),
    ]);

    return {
      fact_checker: factCheck,
      source_analyst: sourceAnalysis,
      context_guardian: contextAnalysis,
      freshness_detector: freshnessAnalysis,
    };
  }
}

module.exports = new AIAgentsService();
