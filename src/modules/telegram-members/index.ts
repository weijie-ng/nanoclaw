/**
 * telegram-members module: the `/add-member` command for Telegram groups.
 * Registers the interceptor at import time (see add-member.ts for behaviour).
 */
import { registerMessageInterceptor } from '../../router.js';
import { handleAddMember } from './add-member.js';

registerMessageInterceptor(handleAddMember);
