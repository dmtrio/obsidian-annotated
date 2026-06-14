/**
 * Pure utility functions for matching comment snippets against document content.
 * No dependencies on Obsidian or CodeMirror.
 */

export function captureSnippet(lineContent: string): string {
	return lineContent.slice(0, 50).trimEnd();
}

export function findLineBySnippet(
	docLines: string[],
	snippet: string,
	hintLine: number,
	radius = 50
): { line: number; confidence: number } | null {
	if (!snippet) return null;

	const lo = Math.max(0, hintLine - radius);
	const hi = Math.min(docLines.length - 1, hintLine + radius);

	// Phase 1: exact startsWith — check hint first, then scan outward
	if (hintLine >= 0 && hintLine < docLines.length && docLines[hintLine].startsWith(snippet)) {
		return { line: hintLine, confidence: 1.0 };
	}
	for (let d = 1; d <= radius; d++) {
		if (hintLine - d >= lo && docLines[hintLine - d].startsWith(snippet)) {
			return { line: hintLine - d, confidence: 1.0 };
		}
		if (hintLine + d <= hi && docLines[hintLine + d].startsWith(snippet)) {
			return { line: hintLine + d, confidence: 1.0 };
		}
	}

	// Phase 2: fuzzy bigram Dice on first 50 chars, threshold >= 0.7
	let bestLine = -1;
	let bestSim = 0;
	let bestDist = Infinity;
	for (let i = lo; i <= hi; i++) {
		const candidate = docLines[i].slice(0, 50).trimEnd();
		const sim = bigramSimilarity(snippet, candidate);
		if (sim >= 0.7) {
			const dist = Math.abs(i - hintLine);
			if (sim > bestSim || (sim === bestSim && dist < bestDist)) {
				bestSim = sim;
				bestLine = i;
				bestDist = dist;
			}
		}
	}
	if (bestLine >= 0) {
		return { line: bestLine, confidence: bestSim };
	}

	// Phase 3: no match
	return null;
}

export function bigramSimilarity(a: string, b: string): number {
	if (a === b) return 1.0;
	if (a.length < 2 || b.length < 2) return 0;

	const bigrams = (s: string): Map<string, number> => {
		const m = new Map<string, number>();
		for (let i = 0; i < s.length - 1; i++) {
			const bg = s.slice(i, i + 2);
			m.set(bg, (m.get(bg) ?? 0) + 1);
		}
		return m;
	};

	const aB = bigrams(a);
	const bB = bigrams(b);
	let intersection = 0;
	for (const [bg, count] of aB) {
		intersection += Math.min(count, bB.get(bg) ?? 0);
	}
	return (2 * intersection) / (a.length - 1 + b.length - 1);
}
