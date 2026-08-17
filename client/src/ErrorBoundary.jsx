import { Component } from 'react';
import { api } from './api';

export default class ErrorBoundary extends Component {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error, info) {
    api.reportClientError(error.message, `${error.stack || ''}\n${info.componentStack || ''}`, window.location.href);
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="crash-screen">
        <h1>Something went wrong</h1>
        <p>Catch a Beast hit an unexpected error. Reloading usually fixes it.</p>
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
