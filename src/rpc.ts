import { Rpc } from '@opencode/plugin/rpc';

const object = { type: 'object' as const };
const errors = { invalid: { type: 'object' as const, properties: { message: { type: 'string' as const } }, required: ['message'] } };
export const BatyaRpc = Rpc.define({
  id: 'batya',
  events: {},
  methods: {
    get: { errors, input: object, output: object },
    save: { errors, input: { ...object, required: ['settings', 'revision'], properties: { settings: object, revision: { type: 'string' } }, additionalProperties: false }, output: object },
    preview: { errors, input: { ...object, required: ['settings', 'text'], properties: { settings: object, text: { type: 'string', maxLength: 256000 }, host: { type: 'string' } }, additionalProperties: false }, output: object }
  }
});
