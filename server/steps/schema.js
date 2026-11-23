// Tiny JSON-schema builders for Claude structured outputs (every object closed, every field required).
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items) => ({ type: 'array', items });
module.exports = {
  obj, arr,
  str: { type: 'string' }, int: { type: 'integer' }, num: { type: 'number' }, bool: { type: 'boolean' },
  enum: (values) => ({ type: 'string', enum: values }),
};
