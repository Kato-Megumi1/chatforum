# Evaluation

The repository ships evaluation code, not the owner's private question set, novel corpus, answer exports, or production vectors. Supply an independently authorized and annotated dataset to the CLI.

Evaluate three things separately: whether the retrieved text supports the question, whether the final answer is correct and responsive, and whether character expression is appropriate. An automatic `grounded` state is not a human accuracy label.

Keep development and blind evaluation families separate; freeze parameters before a blind run. Record source document versions, index manifest, model, persona, prompt versions, ACL scope, tokens, and provider-reported usage. Store exports in ignored local storage. Do not treat unannotated cases as passed or historical diagnostics as a blind score.

The backend scripts `eval:novel` and `eval:score` accept local dataset and report paths. The former calls the configured paid model providers; the latter consumes independently annotated results. Use a disposable test database and authorized source content, and inspect the CLI input types before preparing a dataset.

Ordinary unit tests do not require a novel corpus, the private dataset, or real model credentials. Database integration tests are opt-in and must remain isolated from production.
