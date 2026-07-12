# Third-party notices

Parts of `src/vscode/serialization.ts` and `src/vscode/persistentProtocol.ts`
are adapted from Visual Studio Code at commit
`8b3775030ed1a69b13e4f4c628c612102e30a681`:

- `src/vs/base/parts/ipc/common/ipc.ts`
- `src/vs/base/parts/ipc/common/ipc.net.ts`

Visual Studio Code is Copyright (c) Microsoft Corporation and licensed under
the MIT License. The original copyright and license notice is retained in the
adapted files. The full upstream license is available at
<https://github.com/microsoft/vscode/blob/8b3775030ed1a69b13e4f4c628c612102e30a681/LICENSE.txt>.

The authentication and routing implementation was developed against
code-server v4.20.1, commit `e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe`.
code-server is Copyright (c) Coder Technologies Inc. and licensed under the
MIT License. Its license is available at
<https://github.com/coder/code-server/blob/e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe/LICENSE>.

Runtime and development dependencies retain their respective licenses. Exact
versions are recorded in `package-lock.json`.
