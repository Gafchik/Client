import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      message: "",
    };
  }

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message,
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Frontend runtime failure:", error, errorInfo);
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="app-shell">
          <section className="settings-card error-shell">
            <div className="panel-header">
              <h2>Интерфейс Временно Недоступен</h2>
              <span>Recovery Mode</span>
            </div>
            <div className="stack">
              <p>
                Произошла runtime-ошибка в интерфейсе. Вместо белого экрана приложение перешло в безопасный режим.
              </p>
              <div className="list">
                <div className="list-item">
                  <strong>Сообщение</strong>
                  <span>{this.state.message || "Неизвестная ошибка интерфейса."}</span>
                </div>
              </div>
              <div className="action-row">
                <button type="button" className="primary-button" onClick={() => window.location.reload()}>
                  Перезагрузить интерфейс
                </button>
              </div>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
