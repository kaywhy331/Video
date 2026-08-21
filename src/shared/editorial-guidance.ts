export interface SafeEditorialGuidance {
  role: 'editorial_guidance_only';
  evidenceEligible: false;
  rawTextSharedWithProvider: false;
  seedSha256: string;
  tone: string[];
  pacing: string[];
  structure: string[];
  catalogGroundedEmphasis: string[];
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'before', 'but',
  'can', 'close', 'end', 'for', 'from', 'have', 'into', 'just', 'make', 'more',
  'open', 'over', 'show', 'start', 'than', 'that', 'the', 'their', 'then', 'there',
  'these', 'they', 'this', 'through', 'use', 'very', 'want', 'with', 'would', 'your'
]);

const TONE_SIGNALS = [
  'calm', 'cinematic', 'conversational', 'documentary', 'dramatic', 'energetic',
  'immersive', 'minimal', 'playful', 'reflective'
];
const PACING_SIGNALS = ['brisk', 'fast', 'measured', 'punchy', 'relaxed', 'slow'];
const STRUCTURE_SIGNALS = [
  'architecture', 'closing', 'conclusion', 'culture', 'food', 'history',
  'introduction', 'journey', 'nature', 'nightlife', 'opening', 'overview',
  'recap', 'transport'
];
const IMPERATIVE_OPENERS = new Set([
  'begin', 'close', 'end', 'focus', 'keep', 'make', 'move', 'open', 'show',
  'start', 'transition', 'use'
]);
const FACTUAL_VERBS = new Set([
  'are', 'attracts', 'became', 'built', 'closed', 'contains', 'costs', 'dates',
  'founded', 'had', 'has', 'have', 'is', 'lies', 'opened', 'remains', 'serves',
  'sits', 'stands', 'was', 'were'
]);

function words(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalized(value: string): string {
  return words(value).join(' ');
}

function matchingSignals(tokens: Set<string>, candidates: string[]): string[] {
  return candidates.filter(candidate => tokens.has(candidate));
}

export function createSafeEditorialGuidance(
  startingScript: string | undefined,
  independentEvidence: string[],
  seedSha256: string
): SafeEditorialGuidance | null {
  if (!startingScript) return null;
  const seedTokens = words(startingScript);
  const seedSet = new Set(seedTokens);
  const evidenceTokens = new Set(independentEvidence.flatMap(words));
  const catalogGroundedEmphasis = [...new Set(seedTokens)]
    .filter(token => token.length >= 4 && !STOP_WORDS.has(token) && evidenceTokens.has(token))
    .slice(0, 24);
  return {
    role: 'editorial_guidance_only',
    evidenceEligible: false,
    rawTextSharedWithProvider: false,
    seedSha256,
    tone: matchingSignals(seedSet, TONE_SIGNALS),
    pacing: matchingSignals(seedSet, PACING_SIGNALS),
    structure: matchingSignals(seedSet, STRUCTURE_SIGNALS),
    catalogGroundedEmphasis
  };
}

function factualStatements(value: string): string[] {
  return value
    .split(/\n+|(?<=[.!?])\s+/u)
    .map(statement => statement.trim())
    .filter(Boolean)
    .filter(statement => {
      const tokens = words(statement);
      if (IMPERATIVE_OPENERS.has(tokens[0] ?? '')) return false;
      return tokens.some(token => /\d/u.test(token))
        || tokens.some(token => FACTUAL_VERBS.has(token));
    });
}

export function assertNoUnsupportedEditorialFacts(input: {
  startingScript?: string;
  generatedText: string[];
  independentEvidence: string[];
}): void {
  if (!input.startingScript) return;
  const evidence = input.independentEvidence.map(normalized).filter(Boolean);
  const unsupported = factualStatements(input.startingScript).filter(statement => {
    const candidate = normalized(statement);
    return candidate && !evidence.some(source => source.includes(candidate));
  });
  if (!unsupported.length) return;

  for (const output of input.generatedText) {
    const outputNormalized = normalized(output);
    const outputTokens = new Set(words(output).filter(token => !STOP_WORDS.has(token)));
    for (const statement of unsupported) {
      const statementNormalized = normalized(statement);
      const statementTokens = [...new Set(words(statement).filter(token => !STOP_WORDS.has(token)))];
      const shared = statementTokens.filter(token => outputTokens.has(token));
      const unsupportedNumbers = words(statement).filter(token => /\d/u.test(token))
        .filter(token => !evidence.some(source => words(source).includes(token)));
      const repeatsUnsupportedNumber = unsupportedNumbers.some(token => words(output).includes(token));
      const substantiallyReused = outputNormalized.includes(statementNormalized)
        || (statementTokens.length >= 4 && shared.length >= 4 && shared.length / statementTokens.length >= 0.75);
      if (repeatsUnsupportedNumber || substantiallyReused) {
        throw new Error('Generated script reused a factual statement from operator guidance without independent evidence.');
      }
    }
  }
}
