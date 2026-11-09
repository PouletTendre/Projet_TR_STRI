export class EdgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdgeError';
  }
}

export class AclForbiddenDestinationError extends EdgeError {
  public readonly destination: string;
  public readonly clientId?: string;

  constructor(destination: string, clientId?: string, message?: string) {
    super(
      message ??
        `Accès interdit à la destination interne '${destination}' par la passerelle Edge (ACL violation : seuls les flux chat externes sont autorisés).`
    );
    this.name = 'AclForbiddenDestinationError';
    this.destination = destination;
    this.clientId = clientId;
  }
}
