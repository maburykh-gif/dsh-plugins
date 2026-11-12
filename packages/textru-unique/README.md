# Text.ru uniqueness

Host plugin for DeepSeek Harness that checks text uniqueness through the
[text.ru](https://text.ru) API and tells the agent what exactly to rewrite.

## Tools

| Tool | What it returns |
|---|---|
| `textru_unique` | uniqueness score, report link, matching sources with their percentage, and the fragments of your text that are not unique |
| `textru_balance` | characters left on the account |

Because the API returns the word indexes of every match, the plugin turns them back into
sentences of the original text — so the agent rewrites the flagged fragments instead of
guessing.

## Install

1. Get a `userkey` in your text.ru account (API section).
2. Store it in the DSH credential store as `TEXT_RU_KEY`.
3. Install the bundle and use the tools: ask the agent to check uniqueness, or call
   `textru_unique` directly.

The key is read from the credential store on every call; it is never written into this
package or into the configuration.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `TEXT_RU_KEY` | credential name holding the text.ru key |
| `pollIntervalMs` | `4000` | first poll delay, growing to 10 s |
| `timeoutMs` | `300000` | how long one check may take |

## Limits and costs

- Minimum 100 characters per check; longer texts are accepted up to 150 000.
- Every check spends characters from your balance, including repeated checks after a rewrite.
- The service allows up to 10 texts per second and 3 000 000 characters per hour.
- Text.ru compares against the open web, not against closed university databases.

## Example

```text
Agent: textru_unique({ text: "..." })
→ 43.51% · 2 sources · 4 fragments
```

## License

MIT.
