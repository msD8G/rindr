// Worker for the cloud volumes' shape fields (cloud-field.js, used by clouds.js)
import { shapeField } from './cloud-field.js';

self.onmessage = ({ data }) => {
    try {
        const field = shapeField(data.triangles, data.box, data.scale);
        self.postMessage({ id: data.id, field }, [field.buffer]);
    } catch (err) {
        self.postMessage({ id: data.id, error: err.message });
    }
};
