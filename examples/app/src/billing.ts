import Acme from 'acme-sdk';

const client = new Acme({ apiKey: process.env.ACME_KEY });

export async function charge(cents: number) {
  return client.charges.create({ amount_cents: cents, currency: 'usd' });
}

export async function capture(id: string) {
  return client.charges.capture(id);
}
