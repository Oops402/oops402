
export async function addPayee(ethAddress: string) {
  try {
    const apiKey = process.env.LIT_API_KEY;
    const payerSecretKey = process.env.LIT_PAYER_SECRET_KEY;

    if (!apiKey || !payerSecretKey) {
      throw new Error('Missing Lit relayer credentials');
    }

    const headers: Record<string, string> = {
      'api-key': apiKey,
      'payer-secret-key': payerSecretKey,
      'Content-Type': 'application/json',
    };

    const response = await fetch('https://datil-relayer.getlit.dev/add-users', {
      method: 'POST',
      headers,
      body: JSON.stringify([ethAddress]),
    });

    interface AddUserResponse {
      success: boolean;
      error?: string;
    }

    if (!response.ok) {
      throw new Error(`Error: ${await response.text()}`);
    }

    const data = (await response.json()) as AddUserResponse;
    if (data.success !== true) {
      throw new Error(`Error: ${data.error}`);
    }
  } catch (err) {
    console.warn('Failed to add payee using relayer', err);
    throw err;
  }
  console.log('Payee added: ', ethAddress);
}