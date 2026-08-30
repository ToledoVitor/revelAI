export function originalOrFrameDeleteAt(uploadedAt: string): string {
  return addMilliseconds(uploadedAt, 23 * 60 * 60 * 1000);
}

export function temporaryDeleteAt(createdAt: string): string {
  return addMilliseconds(createdAt, 60 * 60 * 1000);
}

export function canonicalObservationDeleteAt(completedAt: string): string {
  return addMilliseconds(completedAt, 30 * 24 * 60 * 60 * 1000);
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp))
    throw new Error("Expected canonical UTC timestamp.");
  const epochMilliseconds = Date.parse(timestamp);
  if (
    !Number.isFinite(epochMilliseconds) ||
    new Date(epochMilliseconds).toISOString() !== timestamp
  )
    throw new Error("Expected canonical UTC timestamp.");
  return new Date(epochMilliseconds + milliseconds).toISOString();
}
