// v1 is still served for legacy clients; see README.
function validateBatch(batch) {
  if (!Array.isArray(batch)) {
    throw new TypeError("batch must be an array");
  }
  // Size guard: reject anything unreasonably large.
  if (batch.length > 1000) {
    throw new RangeError("batch too large");
  }
  return batch.map((item) => String(item.id));
}

module.exports = { validateBatch };
