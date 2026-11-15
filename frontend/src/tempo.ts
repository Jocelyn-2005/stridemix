export interface CadenceReference {
  multiplier: number;
  cadence: number;
  label: string;
  description: string;
}

export function cadenceReferences(bpm: number | null): CadenceReference[] {
  if (bpm === null || !Number.isFinite(bpm) || bpm <= 0) return [];
  return [
    { multiplier: 0.5, label: "半拍", description: "每两拍一步" },
    { multiplier: 1, label: "原拍", description: "每拍一步" },
    { multiplier: 2, label: "双拍", description: "每拍两步" },
  ]
    .map((reference) => ({ ...reference, cadence: bpm * reference.multiplier }))
    .filter((reference) => reference.cadence >= 60 && reference.cadence <= 240);
}

export function chooseCadenceReference(bpm: number | null, target: number) {
  const references = cadenceReferences(bpm);
  return references.reduce<CadenceReference | null>((chosen, candidate) => {
    if (!chosen) return candidate;
    const difference =
      Math.abs(Math.log(target / candidate.cadence)) -
      Math.abs(Math.log(target / chosen.cadence));
    if (
      difference < -1e-10 ||
      (Math.abs(difference) <= 1e-10 && candidate.multiplier === 1)
    ) {
      return candidate;
    }
    return chosen;
  }, null);
}

export function formatTempo(value: number) {
  return String(Math.round(value * 10) / 10);
}
