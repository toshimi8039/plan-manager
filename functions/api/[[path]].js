import { handleApi } from '../../lib/api.js';

export const onRequest = (context) => handleApi(context.request, context.env);
