const config = require("../config/default.json");
const { validateBatch } = require("./api/v2/validate");

function drain(batch) {
  const ids = validateBatch(batch);
  const chunks = [];
  for (let i = 0; i < ids.length; i += config.maxBatch) {
    chunks.push(ids.slice(i, i + config.maxBatch));
  }
  return { queue: config.queueName, chunks };
}

module.exports = { drain };
