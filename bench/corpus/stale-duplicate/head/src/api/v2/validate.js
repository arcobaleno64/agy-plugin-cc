function validateBatch(batch) {
  if (!Array.isArray(batch)) {
    throw new TypeError("batch must be an array");
  }
  // Size guard: reject anything unreasonably large. An entry with no id used to
  // throw here, which took the whole batch down; skip those instead.
  if (batch.length > 1000) {
    throw new RangeError("batch too large");
  }
  return batch.filter((item) => item && item.id != null).map((item) => String(item.id));
}

module.exports = { validateBatch };
