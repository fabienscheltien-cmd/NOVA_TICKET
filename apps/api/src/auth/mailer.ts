export interface InvitationMail {
  to: string;
  organisation: string;
  role: string;
  link: string;
  expiresAt: Date;
  /** Organisation à l'origine de l'invitation (invitation d'un prestataire par son client). */
  invitePar?: string;
}

export interface PasswordResetMail {
  to: string;
  link: string;
  expiresAt: Date;
}

export interface Mailer {
  sendInvitation(mail: InvitationMail): Promise<void>;
  sendPasswordReset(mail: PasswordResetMail): Promise<void>;
}

export const MAILER = Symbol('MAILER');

/** Développement : écrit dans la console, n'envoie rien. Le prestataire d'e-mail européen reste à choisir. */
export class ConsoleMailer implements Mailer {
  async sendInvitation(mail: InvitationMail): Promise<void> {
    console.log(`[mail simulé] invitation pour ${mail.to} (${mail.organisation}, ${mail.role}${mail.invitePar ? `, invité par ${mail.invitePar}` : ''}) : ${mail.link}`);
  }
  async sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    console.log(`[mail simulé] réinitialisation du mot de passe pour ${mail.to} : ${mail.link}`);
  }
}

/** Tests : conserve les e-mails en mémoire. */
export class MemoryMailer implements Mailer {
  readonly sent: InvitationMail[] = [];
  readonly resets: PasswordResetMail[] = [];
  async sendInvitation(mail: InvitationMail): Promise<void> {
    this.sent.push(mail);
  }
  async sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    this.resets.push(mail);
  }
}
