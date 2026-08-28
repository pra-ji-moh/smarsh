const path = require('path');
const { workspace, window } = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

// The VS Code half of the language server. Almost nothing lives here on
// purpose: everything that decides what a diagnostic says, what completes, and
// what a hover shows is in `src/lsp.js`, which speaks plain LSP and works the
// same in Neovim, Helix, Zed and Emacs. This file only starts it.

let client;

function serverCommand() {
  const configured = workspace.getConfiguration('smarsh').get('serverPath');
  if (configured) return { command: process.execPath, args: [configured, 'lsp'] };

  // Running from a checkout is the common case while the language is young:
  // the extension sits in editors/vscode, so the CLI is two directories up.
  const local = path.join(__dirname, '..', '..', 'bin', 'smarsh.mjs');
  try {
    if (require('fs').existsSync(local)) {
      return { command: process.execPath, args: [local, 'lsp'] };
    }
  } catch {
    // Fall through to PATH.
  }
  return { command: 'smarsh', args: ['lsp'] };
}

function activate(context) {
  const { command, args } = serverCommand();

  const serverOptions = {
    run: { command, args, transport: TransportKind.stdio },
    debug: { command, args: [...args, '--verbose'], transport: TransportKind.stdio },
  };

  const clientOptions = {
    documentSelector: [{ scheme: 'file', language: 'smarsh' }],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher('**/*.smarsh'),
    },
    outputChannelName: 'Smarsh',
  };

  client = new LanguageClient('smarsh', 'Smarsh Language Server', serverOptions, clientOptions);
  client.start().catch((e) => {
    // Failing silently leaves an editor that looks like it has no diagnostics
    // rather than one that could not start the server, which is a bad hour.
    window.showErrorMessage(
      `Smarsh: could not start the language server (${command}). `
      + 'Set "smarsh.serverPath" to your bin/smarsh.mjs, or install smarsh globally. '
      + `Details: ${e.message}`,
    );
  });

  context.subscriptions.push(client);
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
