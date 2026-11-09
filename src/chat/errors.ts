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
