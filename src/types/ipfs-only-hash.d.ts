declare module 'ipfs-only-hash' {
  const hash: {
    of(content: string | Buffer | Uint8Array): Promise<string>;
  };
  export default hash;
}

