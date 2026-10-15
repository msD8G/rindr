// Worker: renders the built-in studio (studio-hall.js) as half float RGBA – at 4k (~0.5 s) too slow for the main thread
import { DataUtils } from 'three';
import { renderStudioHall } from './studio-hall.js';

self.onmessage = ({ data: { width, height } }) => {
    const data = renderStudioHall(width, height, new Uint16Array(width * height * 4), DataUtils.toHalfFloat);
    self.postMessage({ width, height, data }, [data.buffer]);
};
