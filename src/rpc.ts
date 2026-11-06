import { Rpc } from '@opencode/plugin/rpc';

const object = { type: 'object' as const };
const errors = { invalid: { type: 'object' as const, properties: { message: { type: 'string' as const } }, required: ['message'] } };
export const P4pRpc = Rpc.define({
  id: 'p4p',
  events: {},
  methods: {
    get: { errors, input: object, output: object },
    listFailures: { errors, input: object, output: object },
    exportFailure: { errors, input: { ...object, required: ['id'], properties: { id: { type: 'string', minLength: 24, maxLength: 24 } }, additionalProperties: false }, output: object },
    clearFailures: { errors, input: object, output: object },
    importConfig: { errors, input: { ...object, required: ['content'], properties: { content: { type: 'string', maxLength: 8388608 } }, additionalProperties: false }, output: object },
    exportConfig: { errors, input: { ...object, properties: { settings: object }, additionalProperties: false }, output: object },
    setEnabled: { errors, input: { ...object, required: ['enabled'], properties: { enabled: { type: 'boolean' } }, additionalProperties: false }, output: object },
    save: { errors, input: { ...object, required: ['settings', 'revision'], properties: { settings: object, revision: { type: 'string' } }, additionalProperties: false }, output: object },
    preview: { errors, input: { ...object, required: ['settings', 'text'], properties: { settings: object, text: { type: 'string', maxLength: 256000 }, host: { type: 'string' } }, additionalProperties: false }, output: object }
  }
});
