export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

export class SecurityLevelMismatchError extends ChatError {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityLevelMismatchError';
  }
}

export class SequenceNumberError extends ChatError {
  constructor(message: string) {
    super(message);
    this.name = 'SequenceNumberError';
  }
}

export class ExchangeClosedError extends ChatError {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeClosedError';
  }
}

export class ExchangeNotFoundError extends ChatError {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeNotFoundError';
  }
}

export class CertificateValidationError extends ChatError {
  constructor(message: string) {
    super(message);
    this.name = 'CertificateValidationError';
  }
}

export class SignatureVerificationError extends ChatError {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureVerificationError';
  }
}

export class CertificateStatusError extends ChatError {
  constructor(message: string) {
    super(message);
    this.name = 'CertificateStatusError';
  }
}

export class DecryptionError extends ChatError {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}
