'use strict';

/*
 * SMS for one-time codes. Two providers, chosen by which keys are set:
 *
 *   MSG91      MSG91_AUTH_KEY, MSG91_TEMPLATE_ID (a DLT-approved OTP template
 *              with a ##OTP## variable). India requires sender and template
 *              registration on a DLT platform before any business SMS is sent.
 *   Twilio     TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 *
 * With neither, configured() is false and the caller decides what to do.
 */

function makeSms() {
  const msg91 = () => process.env.MSG91_AUTH_KEY && process.env.MSG91_TEMPLATE_ID;
  const twilio = () => process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM;
  return {
    configured: () => !!(msg91() || twilio()),
    async send(to, text) {
      const code = (text.match(/\b(\d{6})\b/) || [])[1];
      if (msg91()) {
        const r = await fetch('https://control.msg91.com/api/v5/otp?' + new URLSearchParams({ template_id: process.env.MSG91_TEMPLATE_ID, mobile: to.replace(/^\+/, ''), otp: code }), {
          method: 'POST', headers: { authkey: process.env.MSG91_AUTH_KEY, 'content-type': 'application/json' }, body: '{}',
        });
        if (!r.ok) throw new Error(`SMS was not sent (${r.status}).`);
        return;
      }
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: text }),
      });
      if (!r.ok) throw new Error(`SMS was not sent (${r.status}).`);
    },
  };
}

module.exports = { makeSms };
