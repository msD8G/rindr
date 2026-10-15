// Importance-sampling table of an equirect environment (see env-cdf.js) – same computation as
// three-gpu-pathtracer's EquirectHdrInfoUniform.updateFrom with the solid-angle weight of EquirectHdrInfoNode
// (luminance · sin θ), off the main thread. Input: RGBA half float, flipY = false.
import { DataUtils } from 'three';

self.onmessage = ({ data: { data, width, height } }) => {
    const { fromHalfFloat, toHalfFloat } = DataUtils;
    const cdfConditional = new Float32Array(width * height);
    const cdfMarginal = new Float32Array(height);
    let totalSum = 0;
    let cumulativeWeightMarginal = 0;
    for (let y = 0; y < height; y++) {
        const sinTheta = Math.sin(Math.PI * (y + 0.5) / height);
        let cumulativeRowWeight = 0;
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const r = fromHalfFloat(data[4 * i]), g = fromHalfFloat(data[4 * i + 1]), b = fromHalfFloat(data[4 * i + 2]);
            const weight = (0.2126 * r + 0.7152 * g + 0.0722 * b) * sinTheta;
            cumulativeRowWeight += weight;
            totalSum += weight;
            cdfConditional[i] = cumulativeRowWeight;
        }
        if (cumulativeRowWeight !== 0) {
            for (let i = y * width, l = i + width; i < l; i++) cdfConditional[i] /= cumulativeRowWeight;
        }
        cumulativeWeightMarginal += cumulativeRowWeight;
        cdfMarginal[y] = cumulativeWeightMarginal;
    }
    if (cumulativeWeightMarginal !== 0) {
        for (let i = 0; i < height; i++) cdfMarginal[i] /= cumulativeWeightMarginal;
    }

    // sorted lookup: random value → row / column (half-texel offset = pixel centre)
    const marginal = new Uint16Array(height);
    const conditional = new Uint16Array(width * height);
    for (let i = 0; i < height; i++) {
        const row = closestIndex(cdfMarginal, (i + 1) / height, 0, height);
        marginal[i] = toHalfFloat((row + 0.5) / height);
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const col = closestIndex(cdfConditional, (x + 1) / width, y * width, width);
            conditional[y * width + x] = toHalfFloat((col + 0.5) / width);
        }
    }
    self.postMessage({ marginal, conditional, totalSum }, [marginal.buffer, conditional.buffer]);
};

function closestIndex(array, target, offset, count) {
    let lower = offset, upper = offset + count - 1;
    while (lower < upper) {
        const mid = (lower + upper) >> 1;
        if (array[mid] < target) lower = mid + 1; else upper = mid;
    }
    return lower - offset;
}
