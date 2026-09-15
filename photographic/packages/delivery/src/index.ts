/**
 * Public surface of `@photographic/delivery`.
 *
 * `createCodeSenderFromEnv` is the only thing that reads `process.env`. Every provider
 * class takes its credentials as arguments, so importing one without a key is safe and
 * testing one needs no environment at all.
 */

export { DeliveryError } from './errors.js';

export { LogCodeSender, type DeliveryLogger } from './log-sender.js';

export {
  CODE_TTL_MINUTES,
  codeEmail,
  codeMessageFor,
  codeSms,
  type CodeMessage,
  type CodeMessageInput,
} from './message.js';

export { ResendEmailSender, type FetchLike, type ResendEmailSenderOptions } from './resend.js';

export { ElksSmsSender, type ElksSmsSenderOptions } from './elks.js';

export {
  ChannelCodeSender,
  createCodeSenderFromEnv,
  type CodeSenderSelection,
  type EmailProvider,
  type SmsProvider,
} from './select.js';
