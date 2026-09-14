import type { NotifyPort } from '../ports.js';

/** Captures invites instead of sending them, so tests can assert on the link. */
export class FakeNotify implements NotifyPort {
  readonly sent: Array<{
    channel: 'email' | 'sms';
    destination: string;
    inviterName: string;
    roomTitle: string;
    url: string;
  }> = [];

  async sendInvite(input: {
    channel: 'email' | 'sms';
    destination: string;
    inviterName: string;
    roomTitle: string;
    url: string;
  }): Promise<void> {
    this.sent.push(input);
  }

  last() {
    return this.sent.at(-1);
  }
}
