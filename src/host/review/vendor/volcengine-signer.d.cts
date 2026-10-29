declare class Signer {
  constructor(request: { region: string; method: string; pathname: string; params: Record<string, string>; headers: Record<string, string>; body: string }, service: string)
  addAuthorization(credentials: { accessKeyId: string; secretKey: string }, date?: Date): void
}
declare const sdk: { default: typeof Signer }
export = sdk
