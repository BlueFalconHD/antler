# Third-party notices

Parts of `src/vscode/serialization.ts`, `src/vscode/persistentProtocol.ts`, and
the call/event wire constants in `src/vscode/ipcClient.ts` are adapted from or
implemented directly against Visual Studio Code at commit
`93cfdd489c3b228840d0f86ec77c3636277c93ea`:

- `src/vs/base/parts/ipc/common/ipc.ts`
- `src/vs/base/parts/ipc/common/ipc.net.ts`

Visual Studio Code is Copyright (c) Microsoft Corporation and licensed under
the MIT License. The original copyright and license notice is retained in the
adapted files. The full upstream license is available at
<https://github.com/microsoft/vscode/blob/93cfdd489c3b228840d0f86ec77c3636277c93ea/LICENSE.txt>.

The authentication and routing implementation was developed against
code-server v4.125.0, commit `fade53fcaf82e7c535cb972a7e3d8da4e43b63a4`.
code-server is Copyright (c) Coder Technologies Inc. and licensed under the
MIT License. Its license is available at
<https://github.com/coder/code-server/blob/fade53fcaf82e7c535cb972a7e3d8da4e43b63a4/LICENSE>.

Runtime and development dependencies retain their respective licenses. Exact
versions are recorded in `bun.lock`.
