export interface InvitationMail {
  to: string;
  organisation: string;
  role: string;
  link: string;
  expiresAt: Date;
}

export interface Mailer {
  sendInvitation(mail: InvitationMail): Promise<void>;
}

export const MAILER = Symbol('MAILER');

/** Développement : écrit dans la console, n'envoie rien. Le prestataire d'e-mail européen reste à choisir. */
export class ConsoleMailer implements Mailer {
  async sendInvitation(mail: InvitationMail): Promise<void> {
    console.log(`[mail simulé] invitation pour ${mail.to} (${mail.organisation}, ${mail.role}) : ${mail.link}`);
  }
}

/** Tests : conserve les e-mails en mémoire. */
export class MemoryMailer implements Mailer {
  readonly sent: InvitationMail[] = [];
  async sendInvitation(mail: InvitationMail): Promise<void> {
    this.sent.push(mail);
  }
}
