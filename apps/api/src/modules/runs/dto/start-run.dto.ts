export class StartRunDto {
  chatId!: string;
  projectId!: string;
  task!: string;
  /**
   * Исходное сообщение пользователя (как он написал в чат). Нужно для
   * детерминированного detectRunMode: executionTask оркестратора часто теряет
   * стоп-фразу «код не пишите», и режим ошибочно становился implementation.
   */
  originalMessage?: string;
  teamId!: string;
  teamName!: string;
  projectPath!: string;
}
