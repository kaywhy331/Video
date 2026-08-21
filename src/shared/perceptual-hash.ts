export function differenceHash(luma: Uint8Array, width = 9, height = 8): string {
  if (width < 2 || height < 1 || luma.length < width * height) {
    throw new Error('Difference-hash input must contain a complete luma frame.');
  }
  const bits: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const offset = y * width + x;
      bits.push(luma[offset]! >= luma[offset + 1]! ? 1 : 0);
    }
  }
  let result = '';
  for (let offset = 0; offset < bits.length; offset += 4) {
    const nibble = bits.slice(offset, offset + 4).reduce((value, bit) => (value << 1) | bit, 0);
    result += nibble.toString(16);
  }
  return result;
}

export function perceptualHashDistance(left: string | null | undefined, right: string | null | undefined): number {
  const a = left?.trim().toLowerCase();
  const b = right?.trim().toLowerCase();
  if (!a || !b || a.length !== b.length || !/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) {
    return Number.POSITIVE_INFINITY;
  }
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    let value = Number.parseInt(a[index]!, 16) ^ Number.parseInt(b[index]!, 16);
    while (value) {
      distance += value & 1;
      value >>>= 1;
    }
  }
  return distance;
}

export function perceptuallySimilar(
  left: string | null | undefined,
  right: string | null | undefined,
  maximumDistance: number
): boolean {
  return perceptualHashDistance(left, right) <= maximumDistance;
}
