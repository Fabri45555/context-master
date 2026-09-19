# Product Requirements Document

## Continuous Context Manager for Coding Agents

**Status:** Draft
**Versione:** 0.1
**Tipo:** Developer Infrastructure / AI Agent Infrastructure

---

# 1. Executive Summary

Il progetto introduce un **Context Manager esterno e model-agnostic** capace di gestire continuamente il contesto di agent di coding come Codex, Claude Code e altri coding agent.

L'obiettivo è evitare che la sessione principale accumuli progressivamente grandi quantità di conversazione, tool output e informazioni temporanee fino a richiedere una compaction pesante.

Il sistema introduce una memoria persistente strutturata e un processo di **continuous compaction**:

> Il contesto dell'agent è temporaneo; lo stato del progetto è persistente.

Il Context Manager osserva gli eventi prodotti dall'agent, applica prima trasformazioni deterministiche a costo quasi nullo e utilizza **LLM worker effimeri** solamente quando è necessaria una comprensione semantica.

Gli worker vengono spawnati, eseguono un'operazione di manutenzione della memoria e terminano. In questo modo il Context Manager stesso non accumula una propria conversazione infinita.

Il sistema deve essere:

* model-agnostic;
* coding-agent-agnostic;
* event-driven;
* stateful a livello di memoria;
* stateless a livello dei worker LLM;
* economico;
* incrementale;
* fault tolerant;
* osservabile;
* capace di funzionare inizialmente come wrapper/sidecar senza modificare il modello principale.

---

# 2. Problema

Gli attuali coding agent tendono a concentrare nella stessa sessione:

* richieste dell'utente;
* piani;
* conversazioni;
* tool calls;
* output dei tool;
* terminal output;
* errori;
* file esplorati;
* decisioni architetturali;
* tentativi falliti;
* informazioni temporanee.

Con il progredire della sessione, il context window cresce.

Questo produce diversi problemi:

### 2.1 Costo

Più contesto significa potenzialmente più token elaborati e maggiore costo.

### 2.2 Degrado del signal-to-noise ratio

Informazioni vecchie e ormai irrilevanti occupano spazio insieme a quelle importanti.

### 2.3 Context compaction tardiva

La compaction tradizionale avviene quando il contesto è già molto grande.

Questo rende l'operazione:

* costosa;
* difficile;
* potenzialmente distruttiva;
* difficile da controllare.

### 2.4 Perdita di informazioni

Una summarization generica può perdere:

* vincoli dell'utente;
* decisioni architetturali;
* motivazioni;
* errori conosciuti;
* requisiti impliciti emersi durante il lavoro.

### 2.5 Memory pollution

L'agent può continuare a portarsi dietro informazioni che non servono più.

---

# 3. Vision

Creare un layer infrastrutturale che renda la memoria degli AI coding agent **continua, selettiva e indipendente dalla sessione LLM**.

L'agent deve poter lavorare per ore o giorni senza dover mantenere nella propria context window tutta la storia.

Il sistema deve trasformare:

```text
Conversation History
        +
Tool History
        +
Project Discoveries
        +
Decisions
        +
User Constraints
```

in:

```text
Persistent Project State
```

dal quale il coding agent può recuperare soltanto ciò che serve.

---

# 4. Product Principle

Il principio architetturale fondamentale è:

> **The agent's context is disposable; the project's state is persistent.**

La sessione LLM non rappresenta più la memoria completa del progetto.

La sessione diventa un ambiente di lavoro temporaneo.

La memoria reale viene mantenuta esternamente.

---

# 5. Obiettivi

## 5.1 Obiettivi principali

### O1 — Continuous Compaction

Ridurre continuamente il contesto attraverso piccoli interventi incrementali invece di attendere una compaction globale.

### O2 — Persistent Project State

Mantenere uno stato strutturato e persistente del progetto.

### O3 — Minimizzare il costo LLM

Usare operazioni deterministiche quando possibile e LLM worker solamente quando necessario.

### O4 — Ephemeral Workers

Ogni worker LLM deve essere effimero:

```text
spawn
  ↓
read state
  ↓
process events
  ↓
update state
  ↓
terminate
```

Il worker non deve costruire una nuova conversazione infinita.

### O5 — Model Agnostic

Il sistema non deve dipendere da Codex, Claude o da uno specifico provider.

### O6 — Agent Agnostic

Il sistema deve poter supportare differenti coding agent attraverso adapter.

### O7 — Preservazione delle informazioni importanti

Le informazioni critiche devono essere preservate esplicitamente e non affidate a una summarization generica.

### O8 — Misurabilità

Il sistema deve permettere di confrontare:

```text
cost without Context Manager
vs
cost with Context Manager
```

oltre a qualità, latenza e perdita di informazioni.

---

# 6. Non-Goals

La prima versione non deve:

* sostituire il coding agent;
* scrivere autonomamente codice;
* modificare il repository senza autorizzazione;
* diventare un nuovo coding agent completo;
* mantenere integralmente tutta la cronologia nel prompt;
* dipendere da un singolo provider LLM;
* richiedere un database distribuito complesso.

---

# 7. Core Architecture

Architettura concettuale:

```text
                    ┌─────────────────────┐
                    │    Coding Agent     │
                    │                     │
                    │ Codex / Claude /    │
                    │ Cursor / Aider /... │
                    └──────────┬──────────┘
                               │
                         Events / State
                               │
                               ▼
                    ┌─────────────────────┐
                    │    Contextd         │
                    │                     │
                    │ Event Collector     │
                    │ State Machine       │
                    │ Deterministic Core  │
                    │ Worker Scheduler    │
                    │ Retrieval Engine    │
                    └──────────┬──────────┘
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
             Working        Project          Raw
             Memory         Memory          History
               L0             L1               L2
```

---

# 8. Memory Architecture

La memoria deve essere organizzata in tre livelli.

## L0 — Working Memory

Memoria piccola, immediatamente disponibile.

Contiene:

```yaml
current_task:
current_plan:
current_state:
next_action:
last_important_event:
active_constraints:
active_errors:
```

Obiettivo:

**pochi token, massimo valore.**

Questa è la memoria che il coding agent dovrebbe ricevere frequentemente.

---

# 9. L1 — Project Memory

Memoria persistente strutturata.

Categorie:

```text
project/
├── goals
├── requirements
├── constraints
├── decisions
├── architecture
├── conventions
├── discoveries
├── completed_work
├── known_issues
├── open_questions
└── important_files
```

Esempio:

```yaml
constraints:
  - id: C001
    text: "Non modificare l'API pubblica"
    source: user
    priority: critical
    status: active

decisions:
  - id: D001
    decision: "Usare PostgreSQL"
    reason: "Infrastructure compatibility"
    status: active

important_files:
  - path: src/auth/token.ts
    purpose: "Token generation"
```

---

# 10. L2 — Raw History

Contiene eventualmente:

* conversazioni;
* tool calls;
* terminal output;
* eventi;
* raw model responses;
* log.

L2 non deve essere inserito normalmente nel prompt.

Serve per:

* audit;
* debugging;
* recovery;
* re-processing;
* verificare una decisione;
* ricostruire lo stato.

---

# 11. Event-Driven Architecture

Il sistema non deve operare esclusivamente a intervalli temporali.

Deve essere principalmente event-driven.

Eventi possibili:

```text
SESSION_STARTED
USER_MESSAGE
ASSISTANT_MESSAGE
TOOL_CALL
TOOL_RESULT
FILE_CHANGED
COMMAND_EXECUTED
ERROR_DETECTED
TASK_STARTED
TASK_COMPLETED
DECISION_DETECTED
REQUIREMENT_CHANGED
CONSTRAINT_CHANGED
ARCHITECTURE_CHANGED
COMPACTION_REQUESTED
SESSION_ENDED
```

Ogni evento deve avere:

```yaml
id:
session_id:
timestamp:
type:
source:
importance:
payload:
```

---

# 12. State Machine

Il Context Manager deve essere modellato come una macchina a stati.

Esempio:

```text
                    ┌───────────────┐
                    │     IDLE      │
                    └───────┬───────┘
                            │
                       event arrives
                            ▼
                    ┌───────────────┐
                    │    INGEST     │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │  CLASSIFY     │
                    └───────┬───────┘
                            │
             ┌──────────────┼───────────────┐
             ▼              ▼               ▼
        DISCARD         UPDATE STATE     NEED LLM
             │              │               │
             │              │               ▼
             │              │        ┌──────────────┐
             │              │        │ SPAWN WORKER │
             │              │        └──────┬───────┘
             │              │               │
             │              │               ▼
             │              │        ┌──────────────┐
             │              │        │ APPLY RESULT │
             │              │        └──────┬───────┘
             │              │               │
             └──────────────┴───────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │   PERSIST     │
                    └───────┬───────┘
                            │
                            ▼
                         IDLE
```

---

# 13. Deterministic First Architecture

Una delle caratteristiche fondamentali del sistema deve essere:

> **Deterministic first, LLM second.**

Prima di spendere token per un LLM worker, il sistema deve verificare se l'operazione può essere eseguita deterministicamente.

## Operazioni deterministiche

Esempi:

* deduplicazione eventi;
* TTL;
* identificazione di file modificati;
* git diff;
* riconoscimento di task completati;
* eliminazione di output duplicati;
* trimming di terminal output;
* riconoscimento di file già indicizzati;
* aggregazione di eventi;
* hash;
* change detection;
* gestione delle versioni;
* gestione dei checkpoint.

Queste operazioni devono avere costo minimo.

---

# 14. Quando usare un LLM

L'LLM worker deve essere invocato quando serve comprensione semantica.

Esempi:

### Decision extraction

```text
"Redis non va bene perché l'infrastruttura di produzione
non lo supporta. Usiamo PostgreSQL."
```

→ decisione persistente.

### Conflict resolution

Due parti della memoria contengono informazioni contraddittorie.

### Semantic summarization

Molti eventi rappresentano una singola informazione.

### Importance evaluation

Determinare se un'informazione è ancora utile.

### Memory restructuring

Riorganizzare informazioni diventate obsolete o duplicate.

---

# 15. Ephemeral LLM Workers

Il worker non deve diventare un secondo agent permanente.

Lifecycle:

```text
SPAWN
  ↓
LOAD RELEVANT STATE
  ↓
LOAD EVENT BATCH
  ↓
ANALYZE
  ↓
GENERATE STATE PATCH
  ↓
VALIDATE PATCH
  ↓
PERSIST
  ↓
TERMINATE
```

Il worker riceve soltanto:

```text
current relevant state
+
new events
+
task-specific instructions
```

Non tutta la cronologia.

---

# 16. Worker Output

Il worker non dovrebbe produrre semplicemente un nuovo summary completo.

Dovrebbe produrre una **state patch**.

Esempio:

```json
{
  "add": {
    "decisions": [
      {
        "id": "D021",
        "text": "Use PostgreSQL instead of Redis"
      }
    ]
  },
  "update": {
    "current_task": {
      "status": "in_progress"
    }
  },
  "remove": [
    "temporary_error_183"
  ]
}
```

Questo rende il sistema:

* incrementale;
* verificabile;
* versionabile;
* reversibile.

---

# 17. Information Value Model

Il sistema deve distinguere tra informazioni con valore differente.

## Critical

Conservare sempre.

Esempi:

* user constraints;
* explicit requirements;
* architecture decisions;
* security constraints;
* API contracts.

## High

Conservare normalmente.

Esempi:

* important discoveries;
* known issues;
* project conventions;
* unresolved questions.

## Medium

Conservare in forma compressa.

## Low

Conservare temporaneamente.

## Ephemeral

Eliminare quando non più utile.

Esempio:

```text
"Ho eseguito npm test"
```

Se il test è passato e non esiste più alcuna informazione derivante dal comando, può essere eliminato.

---

# 18. User Instructions Have Special Priority

Le istruzioni esplicite dell'utente devono avere trattamento speciale.

Esempio:

```text
"Non modificare l'API pubblica."
```

deve diventare:

```yaml
type: constraint
source: user
priority: critical
status: active
```

e non:

```text
summary:
"The user prefers minimal API changes."
```

La semantica deve essere preservata.

---

# 19. Code Is Not Memory

Il sistema non deve cercare di memorizzare tutto il codice nel context store.

Per esempio, invece di:

```text
auth.ts contiene 500 righe...
```

memorizzare:

```yaml
important_file:
  path: src/auth/auth.ts
  purpose: authentication
  last_relevant_commit: abc123
```

Quando serve, il coding agent deve leggere nuovamente il file.

Il repository rimane la source of truth per il codice.

---

# 20. Retrieval

La memoria persistente non deve essere caricata interamente.

Il sistema deve supportare retrieval mirato.

Input:

```text
"Sto implementando refresh token rotation"
```

Output:

```text
relevant decisions
+
relevant constraints
+
relevant files
+
known issues
+
current task
```

Possibili tecniche:

* keyword search;
* metadata filtering;
* embeddings;
* semantic search;
* graph relations;
* hybrid retrieval.

Per l'MVP può essere sufficiente:

```text
structured metadata
+
keyword search
```

---

# 21. Context Injection

Il Context Manager non dovrebbe continuamente modificare il prompt del coding agent.

Preferenza:

```text
Coding Agent
      │
      ├── asks/requires context
      │
      ▼
Context Manager
      │
      ▼
Relevant Memory
```

Il sistema può comunque fornire automaticamente un piccolo bootstrap context:

```text
CURRENT TASK
ACTIVE CONSTRAINTS
CURRENT PLAN
OPEN ISSUES
NEXT ACTION
```

---

# 22. Agent Adapters

Il sistema deve avere un layer adapter:

```text
adapters/
├── codex/
├── claude/
├── cursor/
├── aider/
└── generic/
```

Ogni adapter traduce:

```text
agent-specific events
        ↓
normalized events
```

Il core non deve conoscere i dettagli del provider.

---

# 23. Generic Protocol

Il protocollo interno deve essere provider-neutral.

Esempio:

```json
{
  "session_id": "abc",
  "event_id": "evt_123",
  "type": "tool_result",
  "timestamp": "...",
  "payload": {
    "tool": "terminal",
    "output": "..."
  }
}
```

---

# 24. Continuous Compaction Policy

Il sistema deve poter utilizzare diversi trigger.

### Event trigger

```text
important decision detected
```

### Size trigger

```text
N events accumulated
```

### Token trigger

```text
estimated context > threshold
```

### Time trigger

```text
periodic maintenance
```

### Semantic trigger

```text
state changed significantly
```

### Session trigger

```text
before session reset
```

---

# 25. Adaptive Compaction

Non tutti i task hanno la stessa necessità.

Un task breve:

```text
"Fix typo in README"
```

non necessita di continuous compaction aggressiva.

Un task lungo:

```text
"Refactor authentication architecture"
```

può generare migliaia di eventi.

Il sistema deve quindi adattare la frequenza dei worker.

---

# 26. Cost Controller

Il sistema deve includere un budget.

Esempio:

```yaml
worker_budget:
  max_tokens_per_hour: 10000
  max_cost_per_session: 0.50
  preferred_model: cheap_model
```

Quando il budget viene superato:

```text
LLM compaction
      ↓
disabled/deferred
      ↓
deterministic maintenance continues
```

---

# 27. Model Routing

Il worker non deve necessariamente utilizzare lo stesso modello del coding agent.

Esempio:

```text
Coding:
Claude / GPT high-end

Context management:
small/cheap model
```

Il modello deve essere selezionabile per task:

```yaml
workers:
  classification:
    model: cheap

  summarization:
    model: cheap

  conflict_resolution:
    model: medium

  complex_reconciliation:
    model: high
```

---

# 28. Economics

Il progetto deve misurare il costo totale:

```text
Total Cost =
Coding Agent Cost
+
Context Worker Cost
+
Storage Cost
+
Retrieval Cost
```

e confrontarlo con:

```text
Baseline Cost =
Coding Agent Cost
+
Traditional Compaction Cost
```

La metrica più importante non è quindi:

> "Quanto costa il Context Manager?"

ma:

> **"Quanto costa il sistema completo con Context Manager rispetto alla baseline?"**

---

# 29. Quality Metrics

Il sistema deve misurare anche la qualità.

### Context reduction

```text
raw context tokens
vs
active context tokens
```

### Compression ratio

```text
compressed / original
```

### Important information retention

Percentuale di informazioni critiche preservate.

### Retrieval accuracy

Quanto spesso il sistema recupera le informazioni necessarie.

### False memory

Informazioni erroneamente mantenute o inferite.

### Memory loss

Informazioni importanti perse.

### Recovery success

Capacità di riprendere un task dopo:

* session reset;
* context reset;
* agent restart.

---

# 30. Key KPI

Per il primo MVP:

### K1

Riduzione del context attivo:

**Target:** >70%

### K2

Informazioni critiche perse:

**Target:** ~0%

### K3

Costo aggiuntivo Context Manager:

**Target:** <10–20% del costo totale del coding task

### K4

Tempo aggiuntivo percepito:

**Target:** minimo e non bloccante

### K5

Recovery dopo reset:

Un nuovo agent deve poter riprendere il task utilizzando solamente:

```text
repository
+
persistent memory
```

senza richiedere la conversazione originale completa.

---

# 31. Non-Blocking Design

Il Context Manager non deve rallentare il coding agent inutilmente.

Preferenza:

```text
Coding Agent
     │
     ├───────────────► continue coding
     │
     ▼
 event queue
     │
     ▼
Context Manager
```

La maggior parte delle operazioni deve essere asincrona.

Solo gli eventi critici possono richiedere sincronizzazione.

---

# 32. Persistence

Per l'MVP:

```text
SQLite
+
JSON/JSONL
```

può essere sufficiente.

Struttura:

```text
.context/
├── state.db
├── events/
├── snapshots/
├── memory/
└── logs/
```

In futuro:

* PostgreSQL;
* vector DB;
* distributed event store.

---

# 33. Versioned Memory

Ogni modifica alla memoria deve poter essere tracciata.

```text
Memory v1
   ↓
Memory v2
   ↓
Memory v3
```

Possibilità di:

* rollback;
* diff;
* audit;
* debugging;
* confronto tra versioni.

---

# 34. State Patches

Le modifiche devono essere atomiche.

Esempio:

```text
Worker
  ↓
generate patch
  ↓
validate
  ↓
apply
  ↓
checkpoint
```

Se il worker fallisce:

```text
old state remains valid
```

---

# 35. Failure Handling

Possibili failure:

* worker crash;
* provider unavailable;
* malformed output;
* contradictory memory;
* storage failure;
* timeout;
* budget exceeded.

Principio:

> **Il fallimento del Context Manager non deve bloccare il coding agent.**

In caso di failure:

```text
continue coding
+
retain raw events
+
retry later
```

---

# 36. Security

La memoria può contenere:

* codice;
* secrets indiretti;
* informazioni proprietarie;
* credenziali accidentalmente presenti negli output.

Il sistema deve quindi:

* evitare di inviare dati non necessari a modelli esterni;
* supportare local models;
* redigere secret pattern;
* rispettare `.gitignore`;
* fornire configurazione per file/cartelle sensibili;
* permettere storage completamente locale.

---

# 37. Privacy

Default consigliato:

```text
Raw history:
local

Project memory:
local

LLM worker:
configurable
```

L'utente deve poter scegliere:

```text
local model
remote model
no external LLM
```

---

# 38. Observability

Il sistema deve fornire metriche:

```text
events processed
events discarded
events compressed
workers spawned
worker tokens
worker cost
memory size
active context size
compression ratio
retrieval count
retrieval relevance
errors
```

Esempio:

```text
Context Manager

Session: abc123

Events:                 4,821
Compressed:             4,102
Discarded:              612
Persistent memories:    107

Active context:         3.2k tokens
Raw equivalent:         94k tokens

Workers spawned:        18
Worker cost:            $0.07

Estimated saved:        $0.41
```

---

# 39. User Experience

Il sistema dovrebbe essere quasi invisibile.

Il developer dovrebbe poter fare:

```bash
contextd run -- claude
```

oppure:

```bash
contextd run -- codex
```

e ottenere automaticamente:

```text
agent
+
continuous context management
```

Possibile modalità:

```bash
contextd attach <session>
```

per agent già avviati.

---

# 40. CLI

Possibili comandi:

```bash
contextd run -- claude
contextd run -- codex
contextd status
contextd memory
contextd inspect
contextd replay
contextd compact
contextd export
contextd reset
```

---

# 41. Developer UI

Una UI futura potrebbe mostrare:

```text
CURRENT STATE

Task:
Implement OAuth refresh token rotation

Active constraints:
✓ Public API unchanged
✓ PostgreSQL
✓ Node 22

Decisions:
✓ JWT access tokens
✓ Refresh token rotation

Open issues:
• Revocation strategy

Context:
3.4k / 128k

Memory:
92 items

Workers:
12

Cost:
$0.06
```

---

# 42. Memory Explainability

Il sistema deve permettere di sapere:

> "Perché questa informazione è stata mantenuta?"

Esempio:

```text
Constraint C001

Source:
User message #182

Reason:
Explicit user requirement

Last validated:
Session #42
```

Questo è fondamentale per debugging e trust.

---

# 43. Memory Decay

Non tutta la memoria deve vivere per sempre.

Ogni elemento può avere:

```yaml
importance:
confidence:
created_at:
last_used:
last_validated:
ttl:
status:
```

Possibili stati:

```text
ACTIVE
STALE
SUPERSEDED
ARCHIVED
DELETED
```

---

# 44. Contradiction Handling

Esempio:

```text
v1:
Use Redis

v2:
Use PostgreSQL
```

Non bisogna semplicemente cancellare v1.

Il sistema dovrebbe creare:

```yaml
decision:
  current: PostgreSQL
  supersedes: Redis
  reason: ...
```

La storia rimane nell'archivio.

---

# 45. Context Budget

Il sistema deve trattare il context come una risorsa.

Esempio:

```text
Budget: 8,000 tokens

Current:
────────────

Task               500
Constraints         300
Decisions           600
Relevant files      900
Open issues         400
Recent events       800
-----------------------
Total              3,500
```

Restano 4.500 token per retrieval dinamico.

---

# 46. Intelligent Retrieval

Quando il coding agent cambia task:

```text
Task A
  ↓
retrieval A

Task B
  ↓
retrieval B
```

Non tutto lo stato deve rimanere attivo.

Questo consente al sistema di avere una memoria molto grande senza avere un context enorme.

---

# 47. Example

Supponiamo una sessione di 6 ore.

Raw history:

```text
210,000 tokens
```

Project memory:

```text
18,000 tokens
```

Working memory:

```text
2,500 tokens
```

Relevant retrieved context:

```text
3,000 tokens
```

Il coding agent potrebbe quindi lavorare con:

```text
~5,500–8,000 relevant tokens
```

anziché con l'intera cronologia.

---

# 48. End-to-End Flow

```text
Developer
   │
   ▼
Coding Agent
   │
   ├── tool call
   ├── reasoning
   ├── file change
   ├── test
   └── result
          │
          ▼
      Event Queue
          │
          ▼
   Deterministic Engine
          │
       ┌──┴───┐
       │      │
   discard  update
       │      │
       └──┬───┘
          │
          ▼
     importance?
          │
     ┌────┴─────┐
     │          │
    no         yes
     │          │
     │          ▼
     │      Worker Queue
     │          │
     │          ▼
     │      Ephemeral LLM
     │          │
     │          ▼
     │      State Patch
     │          │
     └────┬─────┘
          ▼
      State Store
          │
          ▼
      Retrieval
          │
          ▼
      Coding Agent
```

---

# 49. MVP

La prima versione dovrebbe essere volutamente piccola.

## MVP Scope

Supportare:

* un coding agent;
* eventi principali;
* SQLite;
* JSON state;
* deterministic filtering;
* un LLM worker;
* working memory;
* decisions;
* constraints;
* current task;
* basic retrieval;
* CLI;
* metriche di costo.

Non servono inizialmente:

* vector DB;
* UI;
* distributed architecture;
* multi-agent orchestration;
* sofisticato knowledge graph.

---

# 50. MVP Worker Prompt

Il worker deve avere un compito molto specifico:

```text
You are a context maintenance worker.

Your job is NOT to solve the coding task.

Your job is to maintain persistent project state.

Given:
1. current state
2. new events
3. existing memory

Determine:

- what must be preserved
- what can be compressed
- what can be discarded
- what decisions were made
- what constraints changed
- what the current task state is

Never invent information.

Do not store source code unless explicitly necessary.

Return only a validated state patch.
```

---

# 51. MVP Deterministic Rules

Prima dell'LLM:

```text
IF duplicate event
    discard

IF terminal output > N chars
    truncate + hash

IF file unchanged
    don't re-index

IF task completed
    update status

IF git diff available
    store metadata instead of raw diff

IF event is low-value
    delay processing

IF event is critical
    persist immediately
```

---

# 52. MVP State Schema

```yaml
version: 1

project:
  name:

current_task:
  description:
  status:
  next_action:

constraints: []

decisions: []

open_questions: []

known_issues: []

important_files: []

recent_context: []

metadata:
  last_updated:
  version:
```

---

# 53. Experimental Phase

Prima di costruire un'infrastruttura completa, bisogna validare l'ipotesi economica.

Testare task reali:

### Short task

30 minuti.

### Medium task

2 ore.

### Long task

6+ ore.

Confrontare:

```text
Baseline
vs
Continuous Compaction
```

Misurare:

* token;
* costo;
* context size;
* number of compactions;
* task completion;
* errori;
* memory loss;
* latency.

---

# 54. Success Criteria

Il progetto è validato se:

1. riduce significativamente il context attivo;
2. mantiene le informazioni critiche;
3. non rallenta significativamente il coding;
4. il costo dei worker è basso;
5. permette recovery dopo reset;
6. funziona con almeno due coding agent;
7. non richiede modifiche al modello principale.

---

# 55. Roadmap

## Phase 0 — Research

* definizione event schema;
* benchmark baseline;
* definizione memory schema.

## Phase 1 — MVP

* daemon;
* SQLite;
* deterministic engine;
* worker;
* state machine;
* CLI;
* un adapter.

## Phase 2 — Multi-agent

* Codex;
* Claude;
* generic adapter.

## Phase 3 — Cost Optimization

* model routing;
* worker batching;
* adaptive scheduling;
* budgets.

## Phase 4 — Retrieval

* semantic retrieval;
* hybrid search;
* context budgeting.

## Phase 5 — UI

* state explorer;
* memory inspector;
* cost dashboard;
* event timeline.

## Phase 6 — Advanced Memory

* contradiction resolution;
* confidence;
* memory decay;
* knowledge graph;
* learned compaction policies.

---

# 56. Future Architecture

La possibile architettura finale:

```text
                    Developer
                        │
                        ▼
              ┌──────────────────┐
              │   Coding Agent   │
              └────────┬─────────┘
                       │
                       ▼
                ┌──────────────┐
                │ Contextd SDK │
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │ Event Stream │
                └──────┬───────┘
                       │
              ┌────────┴─────────┐
              ▼                  ▼
       Deterministic Core   Worker Scheduler
              │                  │
              │                  ▼
              │           Ephemeral Workers
              │                  │
              └────────┬─────────┘
                       ▼
                Memory Manager
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       Working       Project       Raw
       Memory        Memory      History
          │            │            │
          └────────────┼────────────┘
                       ▼
                Retrieval Engine
                       │
                       ▼
                 Context Builder
                       │
                       ▼
                 Coding Agent
```

---

# 57. Long-Term Product Thesis

Il progetto non dovrebbe essere considerato semplicemente un:

> "summarizer per coding agent".

La tesi più ampia è:

> **Un layer di memoria e context orchestration indipendente dal modello e dall'agent.**

Il coding agent diventa quindi soltanto un consumer della memoria.

Questo apre la possibilità di cambiare:

```text
Claude → Codex → Gemini → local model → altro agent
```

senza perdere lo stato del progetto.

La memoria diventa indipendente dalla sessione e dal provider.

---

# 58. Strategic Differentiator

Il principale elemento differenziante non è usare un LLM per fare summarization.

È la combinazione di:

```text
Deterministic processing
+
Event-driven architecture
+
State machine
+
Ephemeral LLM workers
+
Structured persistent memory
+
Selective retrieval
+
Adaptive compaction
+
Cost-aware model routing
```

In particolare:

> **Deterministic first, semantic second.**

riduce il costo e rende il sistema più prevedibile.

---

# 59. Core Design Principles

Il progetto deve seguire questi principi:

### 1. Memory over history

Conservare lo stato, non necessariamente la storia.

### 2. State over summary

Preferire strutture semantiche a un grande testo riassuntivo.

### 3. Deterministic over probabilistic

Usare codice quando il problema può essere risolto deterministicamente.

### 4. Ephemeral over persistent agents

Gli LLM worker devono essere usa-e-getta.

### 5. Repository over memory

Il codice vive nel repository, non nella memoria semantica.

### 6. Relevant context over complete context

Fornire ciò che serve, non tutto ciò che esiste.

### 7. Async over blocking

La manutenzione del context non deve rallentare il coding.

### 8. Measurable over assumed

Ogni ottimizzazione deve essere valutata in termini di:

```text
cost
latency
quality
retention
```

---

# 60. Final Product Definition

**Continuous Context Manager** è un middleware per AI coding agent che:

1. osserva la sessione;
2. trasforma gli eventi in stato;
3. elimina deterministicamente ciò che non serve;
4. comprime semanticamente ciò che merita di essere mantenuto;
5. utilizza LLM worker effimeri;
6. mantiene una memoria persistente strutturata;
7. recupera solo il contesto rilevante;
8. mantiene il context window del coding agent piccolo;
9. misura continuamente costo e qualità;
10. permette al coding agent di essere sostituito senza perdere lo stato del progetto.

La visione finale è trasformare il modello da:

```text
"Devo ricordare tutto quello che è successo."
```

a:

```text
"Devo conoscere lo stato attuale del progetto
e recuperare la storia soltanto quando è necessaria."
```

Questo costituisce il fondamento del sistema.

---

# 61. Emendamenti (dall'implementazione)

Questa sezione raccoglie le modifiche al PRD che l'implementazione ha reso necessarie. Ogni
voce indica la sezione che emenda e perché. Il dettaglio tecnico è in
[docs/prd-review.md](docs/prd-review.md); il posizionamento rispetto ai progetti simili
esistenti è in [docs/landscape.md](docs/landscape.md).

## 61.1 §31 — "non bloccante" diventa un numero

Il path degli hook è sincrono per l'agent, quindi ha un tetto esplicito:
`limits.hook_latency_ms` (default 250ms) e un tetto duro a 1000ms oltre il quale viene emesso
un warning. Misurato su una sessione reale: p50 9ms. Senza un numero, "non bloccante" non è
verificabile.

## 61.2 §29 / K1 — tre numeri, non uno

K1 va riportato come `token_reduction` (il rapporto grezzo), `coverage` (la quota di eventi da
cui qualcosa ha effettivamente derivato stato) e `effective_reduction` (il prodotto, il numero
da citare). Il solo rapporto legge 99.9% su un backlog che nessuno ha letto: è un arretrato,
non compressione.

`coverage` conta solo gli eventi da cui è stato derivato stato. Un evento risolto che non ha
prodotto nulla è *inerte* e va sottratto: contarlo faceva leggere 98.9% di coverage a fronte di
739 eventi memorizzati e memoria **vuota**, cioè un tasso di scarto travestito da compressione.

## 61.3 §22 — la superficie di ingestione la dichiara l'adapter

Ogni adapter dichiara le proprie `surfaces` (tipo, se preferita, se installabile
automaticamente, come localizzare i transcript). La CLI non contiene percorsi specifici per
agent: è ciò che "agent agnostic" richiede davvero. Verificabile con `contextd surfaces` e
`contextd doctor`.

## 61.4 §29 — una metrica di qualità della memoria

`precision` riporta la quota di memoria mai recuperata, ritirata entro un'ora, a bassa
confidenza o non verificata. Il modo in cui il sistema fallisce nella pratica non è né la
perdita né il falso ricordo, ma la memoria vera e inutile: `never_retrieved_ratio` è il
segnale da guardare.

## 61.5 §44 — serve il *rilevamento* delle contraddizioni, non solo la risoluzione

La sezione assume che le contraddizioni arrivino già etichettate. Non è così: qualcosa deve
cercarle. Il rilevamento è deterministico e gratuito (similarità trigram più polarità) e un
modello viene speso solo per decidere quale lato vince. Il confronto attraversa le categorie:
un vincolo dell'utente contraddetto da una decisione dell'agent è esattamente il caso K2, e un
controllo intra-categoria è l'unica cosa che lo manca.

## 61.6 §32 — rimuovere lo store distribuito dal futuro

`commitPatch` valida e applica in una singola transazione SQLite sincrona, e tutto il codice è
sincrono di conseguenza: Postgres significa riscrivere l'intera codebase in async, per un
beneficio nullo su uno strumento mono-macchina e mono-sviluppatore. Il bisogno reale è la
*portabilità*, che è la riproduzione del patch log: `contextd export` / `contextd import`.
Se si vuole memoria condivisa fra più utenti, merita un PRD proprio, perché auth, tenancy e
semantica dei conflitti fra utenti sono il suo contenuto effettivo.

## 61.7 §24 — la compaction continua è una scala, e la compaction dura è il fallimento

Emendamento più sostanziale. I trigger di §25 osservano la *nostra* coda; la quantità che
conta per l'utente è l'occupazione del context dell'**agent**, che ogni adapter già riporta
per turno. La risposta è graduata:

```text
occupazione < 55%   steady       ingest e fold, nient'altro è giustificato
           >= 55%   maintain     solo deterministico: fold del backlog, decay, retention
           >= 75%   consolidate  si spende un modello: estrazione, risoluzione conflitti
           >= 90%   reduce       riconciliazione dell'intera memoria; la compaction è imminente
```

Tre conseguenze da recepire nel PRD:

1. **La compaction dura dell'agent è il caso di fallimento, non il meccanismo.** Va contata:
   `hard_compactions` è il numero di volte in cui la scala non è riuscita a prevenirla, ed è
   l'unico modo onesto di valutarla. Si propone come **K6**.
2. **K5 va chiesto anche *prima* del reset.** `recovery_ready` risponde a "se l'agent
   compattasse adesso, resterebbe abbastanza stato derivato per continuare?". Occupazione alta
   con un backlog non processato è il fallimento specifico che questo rende visibile.
3. **La finestra di context non si deduce dal nome del modello.** Su una sessione reale l'agent
   dichiarava `claude-opus-5` occupando 512.598 token: assumere 200k dà il 256% di occupazione
   e blocca la scala sul gradino più costoso per sempre. Un turno che è entrato dimostra che la
   finestra è almeno quella: l'osservazione batte l'inferenza, e `window_source` dice da dove
   viene il numero.

## 61.8 §21 / §46 — la slice sempre attiva va guadagnata

Un'ipotesi incerta di un worker non deve essere pagata in ogni sessione. Sotto
`context_budget.min_bootstrap_confidence` (0.5) un item resta fuori dal bootstrap ma
pienamente raggiungibile per query: trattenuto, non perso. Ciò che ha detto l'utente e ciò che
è `critical` entra sempre, perché trattenerlo è la perdita che K2 vieta.

## 61.9 §39 / §54.7 — il proxy verso il provider è escluso, non differito

Mettersi fra l'agent e la sua API upstream e riscrivere la richiesta è la strada che alcuni
progetti simili hanno scelto. Va esclusa: invalida il prompt cache proprio nel punto in cui
serve (il caching è per prefisso, e il collapsing riscrive il prefisso), rende il manager un
single point of failure per la sessione contro §35, e obbliga a possedere credenziali e formato
di richiesta di ogni provider. Hooks più MCP ottengono il controllo del contesto senza mai
tenere in mano la richiesta dell'agent. Discussione completa in
[docs/landscape.md](docs/landscape.md) §3.

## 61.10 §57 / §58 — la tesi è un context runtime, non un memory manager

La memoria persistente per coding agent è una categoria già popolata. La tesi difendibile è
più stretta e resta vera:

> un runtime di contesto esterno che decide, in continuo e per la maggior parte senza modello,
> cosa un qualsiasi coding agent debba avere in contesto adesso — con la compaction dura come
> caso di fallimento e non come meccanismo.

Le tre responsabilità vanno nominate separatamente, perché sono separate nel codice: **Memory**
(cosa vale ricordare), **Context** (cosa va nel prompt adesso), **Lifecycle** (quando
consolidare, spawnare, compattare, fare checkpoint).

## 61.11 §13 / §17 — il gate semantico è asimmetrico

Il PRD tratta "serve un modello?" come una classificazione simmetrica. Non lo è: un falso
negativo perde per sempre e in silenzio il ragionamento dell'agent, un falso positivo costa
qualche centinaio di token del tier cheap.

Su una sessione reale, **102 messaggi agent su 106 non sono mai arrivati a un modello**, perché
il gate era il solo `looksLikeDecision` — cue per decisioni formulate come intenzioni ("useremo
X invece di Y", "perché"). I messaggi reali enunciano *findings* in forma dichiarativa e non
corrispondevano a nulla:

> "Found the real bug: the adapter default importance was treated as a deliberate claim."

Ora il gate accetta cue di decisione, cue di scoperta, **oppure** la sola sostanza: una soglia di
lunghezza misurata, non indovinata (mediana reale 79 caratteri di narrazione di progresso, solo
15 messaggi su 106 oltre 150 caratteri). Costo del recupero: ~7k token sul tier cheap.

Nota per §29: **nessuna metrica del PRD poteva scoprirlo.** `precision` misura ciò che teniamo;
gli eventi che non abbiamo mai letto non lasciano traccia da contare. L'unico modo è stato
leggere a mano gli eventi scartati.

## 61.12 §34 / §29 — "risolto" non è "ha prodotto stato", in tutti e tre i punti

La stessa confusione è emersa tre volte, e la terza è la più grave:

1. **fold a ingest** — gli eventi inerti erano marcati `processed`, quindi 739 eventi con memoria
   vuota leggevano 98.9% di coverage;
2. **dentro il fold** — una sola lista `consumed`, quindi un errore *rifiutato* come rumore
   contava come stato derivato;
3. **nel worker** — una patch vuota marcava `processed` tutto il batch. Un modello sbagliato, o
   che ignora il contratto JSON, svuota la coda, riporta `ok` e fa salire la coverage verso il
   100% con memoria vuota.

Regola da recepire: **ogni stato che significa "fatto" deve dichiarare se ne è venuto qualcosa.**
Un solo booleano stava per due fatti diversi, e ha prodotto tre bug.

Conseguenza operativa: una patch vuota chiude il batch come inerte (la coda deve svuotarsi,
altrimenti lo stesso batch viene riletto per sempre a pagamento), e `doctor` segnala una serie di
run che leggono eventi e non registrano nulla — senza quel segnale un modello rotto è
indistinguibile da un progetto tranquillo.

## 61.13 §37 — `local_only` è una promessa sul modello, non sul daemon

`Provider.isLocal` era una costante e ollama dichiarava `true`. Ma ollama gira in locale e fa da
proxy verso un host remoto per i modelli `*-cloud`: un tier puntato su un modello cloud passava il
gate `local_only` e `doctor` stampava **local**, mentre ogni prompt lasciava la macchina. Lo stesso
buco valeva per qualunque `base_url` non di loopback.

§37 è una delle poche promesse del PRD che l'utente non può verificare da sé, quindi deve essere
esatta. Il giudizio ora è per modello: suffisso `-cloud` o `base_url` non loopback ⇒ remoto,
`doctor` lo stampa e sotto `local_only` il run viene rifiutato nominando il modello.

Generalizzazione da recepire: **un flag che descrive il trasporto prima o poi sbaglia sulla
destinazione.**

## 61.14 §27 — un modello di reasoning può non restituire nulla

Primo run reale contro un modello di reasoning da 120B: 19.458 token di input, **7.669 token di
output in due tentativi, zero contenuto** — l'intero budget speso nel canale di ragionamento, che
il provider restituisce separato da `content`. Il runner riportava solo `no JSON object found`:
vero e inutile, indistinguibile da un modello che non aveva nulla da dire.

§27 deve prevedere, per tier: un interruttore sul reasoning (`think`, non inviato di default) e un
messaggio di errore che nomini la causa. Va anche registrato ciò che ha funzionato: patch rifiutata
due volte, run `invalid`, **33 eventi rimasti pending**, stato fermo a v1 — §35 ha tenuto sotto un
guasto reale, non simulato.

## 61.15 §18 / §36 — lo scaffolding di sessione non è l'utente che parla

§18 dà priorità speciale alle istruzioni esplicite dell'utente, e `isProtected` la rende
permanente. Serve quindi una definizione esatta di "l'utente ha detto".

Nella prima estrazione reale, due dei tre `constraints` prodotti erano **impalcatura dell'harness**
— "do not acknowledge the summary, do not recap" e "non rispondere ai messaggi marcati
local-command-caveat" — registrati come `source: user` + `critical`, quindi da quel momento
inamovibili da qualsiasi patch. Il tier più privilegiato della memoria riempito di plumbing.

Tre cause: il filtro guardava solo l'**inizio** del turno (tutto ciò che è appeso dopo sopravviveva);
il preambolo di ripresa dopo compaction non ha alcun tag e sembra un messaggio utente; e
`USER_MESSAGE` viene emesso da **tre** punti dell'adapter, di cui uno solo era filtrato.

Correlato: un terminale incollato *è* l'utente che parla, ma un cue che capita dentro l'output
incollato non è una proibizione. Resta `high`, non `critical`, perché `critical` è l'unico livello
che non si può più ritirare.

## 61.16 §43 — la confidenza è una pretesa da guadagnare

I 18 item estratti dichiaravano tutti `confidence: 1.00`. Così il campo non porta informazione e
disattiva in silenzio `min_bootstrap_confidence`. §43 elenca `confidence` fra i metadati ma non dice
chi può affermarla: `normalizePatch` ora limita a 0.9 tutto ciò che non è autorato dall'utente.
Stessa disciplina di `importance_source` — **un componente non può affermare una certezza che non
può avere.**

## 61.17 §9 — la distinzione fra decisione e lavoro svolto va scritta nel prompt

Diciotto item sono finiti in `decisions`, e la maggior parte era lavoro completato ("aggiunti i test
di regressione per il bug della importance"). Una decisione è una scelta che **vincola ciò che
viene dopo**; un changelog no. Senza la distinzione esplicita, la sezione sempre attiva `Decisions`
diventa un registro delle modifiche e perde il suo scopo.

## 61.18 §34 — atomico non vuol dire "tutto o niente anche sui no-op"

§34 chiede patch atomiche, e la lettura letterale è costata caro: al secondo run reale il modello
ha inventato tre target di `link` (uno era un **percorso di file**) e ha chiesto la rimozione di due
id letti dentro il testo degli eventi. La patch è stata rifiutata due volte e **45 eventi di
estrazione corretta sono andati persi**.

Un `remove` di un id inesistente non rimuove niente; un `link` verso un id inesistente non collega
niente. Sono no-op dimostrabili: scartarli è identico al fatto che il modello non li avesse scritti.
`pruneInertOperations` li elimina, annota lo scarto nella nota della patch, e **non tocca** `update`
né `supersede` — un target `update` sbagliato significa che il modello voleva cambiare qualcosa di
reale, e scartarlo in silenzio cambia l'intenzione invece di normalizzarla. La patch dell'utente non
viene mai potata: lì l'errore va segnalato.

La garanzia che conta resta intatta: un arco pendente non entra mai nel grafo.

Da aggiungere a §50/§16: gli unici id referenziabili sono quelli presenti nello stato fornito, o
quelli che la patch stessa assegna in `add`. Mai un id citato dentro il testo di un evento, mai un
percorso di file.

## 61.19 §36 — il rifiuto dell'harness non è un problema del progetto

Il fold deterministico ha registrato quattro volte come `known_issues` il testo "Permission for this
action was denied by the … classifier", completo delle istruzioni su cosa l'agent può fare invece.
Stessa categoria dei rate limit e dei tentativi di percorso inesistente: uno strumento che l'harness
ha rifiutato di eseguire non dice nulla sul codice.

## 61.20 §34 / §16 — la degradazione va alla granularità dell'output, non della richiesta

Tre volte lo stesso difetto ha distrutto dati reali:

| Dove | Cosa è andato perso |
|---|---|
| validazione in `commitPatch` | 45 eventi, per tre target di `link` inventati |
| schema in `parsePatch` | 48 eventi e 22 item, per **un** campo `text` mancante su 23 |
| patch vuota nel worker | la coda svuotata e contata come coverage |

Ogni volta l'output del modello era in larga parte corretto e la risposta della pipeline era
tutto-o-niente. Il principio da recepire: **un componente che consuma output di un modello deve
degradare alla granularità dell'output, non della richiesta.** Si scarta la voce, non il batch; si
scarta il no-op, non la patch.

Contro-regola, perché non diventi una scusa per la permissività: si salva solo ciò che è
dimostrabilmente inerte (un `remove` verso un id inesistente) o dimostrabilmente inusabile (un `add`
senza testo non è un fatto). Mai ciò che porta intenzione: `update`, `supersede` e i controlli sugli
item protetti restano intoccati. E nessun valore sbagliato viene coercito in uno valido — un
`importance` non valido fa cadere la voce, non viene arrotondato.

## 61.21 §18 — un turno misto non è né tutto utente né tutto impalcatura

Quarto run reale: il vincolo di scaffolding è tornato (*"do not acknowledge the summary"*) come
`source: user` + `critical`, perché il controllo sul preambolo guardava solo i primi 600 caratteri e
un riassunto di compaction seppellisce quell'istruzione migliaia di caratteri più in basso.

Correggerlo scandendo tutto il testo ha rotto nel verso opposto: il turno cadeva intero e con esso
**il goal originale del progetto**, che nei transcript esisteva solo come citazione dentro quel
riassunto.

Sono lo stesso errore — trattare un turno misto come tutto-o-niente, quarta occorrenza. La
distinzione da recepire in §18: una **riga di istruzione** all'harness si rimuove dovunque appaia;
un turno si scarta intero solo se la sua **apertura** è inquadramento dell'harness.

Inoltre: un permesso concesso per questa sessione non è un vincolo di progetto. Un `constraint` è
una regola stabile sul progetto o sul codice; preferenze di risposta e istruzioni sulla
conversazione non lo sono, e non devono mai finire in `user` + `critical`, la sola combinazione che
non si può più ritirare.

## 61.22 §38 — un run a due tentativi deve poter spiegarsi

`worker_runs` aveva una sola colonna `error`, quindi il primo tentativo non lasciava traccia: un
repair pass che restituisce 3 item dove il primo ne aveva 22 è invisibile. Ora il runner registra
una traccia per passata — cosa è stato scartato, cosa rifiutato, quante operazioni portava ciascuna
— e la salva **anche quando il run riesce**. Senza quella, "il secondo tentativo era peggiore del
primo" è un'ipotesi senza prove.

## 61.23 §34 — una regola di degradazione ha bisogno del proprio caso di fallimento

Quinto run reale. La traccia per passata (§61.22) ha subito pagato:

```
v1->v2  worker  working
  dropped malformed: add[0] … add[9] | dropped inert: link … (7)
```

**Tutti e dieci gli item scartati**, i sette link rimasti senza destinazione, e ciò che restava era
un blocco `working` — che non è vuoto, quindi la patch è passata, è stata applicata, ha riportato
`ok patch_applied` e ha marcato 58 eventi come processati. **Zero item memorizzati.**

Il salvataggio per-voce introdotto in §61.20 aveva prodotto esattamente il fallimento che §61.12
esiste per impedire, per una strada che quella regola non copriva.

Correzione: perdere **tutte** le voci di un'operazione non è un salvataggio, è il modello che ha
sbagliato la forma. In quel caso non si salva niente e l'errore di schema va alla passata di
riparazione, l'unica cosa che può correggere una forma.

Regola generale da recepire: **ogni regola di degradazione deve dichiarare il proprio caso di
fallimento**, altrimenti diventa un percorso di successo silenzioso. La prima volta, in questa
revisione, che la perdita di dati è stata causata da una mia correzione e non da un difetto
originario.

Due cose minori emerse dalla stessa traccia: diceva *quali* voci fallivano ma non *perché* (ora
porta il campo e il messaggio per voce), e il prompt si contraddiceva — chiedeva `id` espliciti per
collegare item creati nella stessa patch mentre la forma di `add` mostrata sotto **non elencava
`id`**.

## 61.24 §29 / §30 — la definizione finale di coverage, e K1 centrato

Al sesto run reale il loop si è chiuso: 14 item (6 decisioni, 5 scoperte, 3 lavori completati),
coda a zero, `replay --verify` consistente, nessuna contraddizione, confidenze variabili, nessuno
scaffolding. La contraddizione sull'`id` nel prompt era davvero la causa dei dieci `add` malformati.

Restava sbagliata **la metrica**, e nello stesso modo di tutto il resto. `Effective (K1)` leggeva
18.9% con **zero** eventi pendenti: coverage divideva per *tutti* gli eventi memorizzati, quindi 994
tool result correttamente scartati contavano contro di noi. Di nuovo "abbiamo scelto di non derivare
nulla da questo" confuso con "non l'abbiamo ancora guardato".

Definizione finale: **`coverage = derived / (derived + pending)`** — degli eventi che potevano
produrre stato, quanti l'hanno fatto — con `derived === 0` bloccato a zero, perché un worker che
restituisce patch vuote chiude i batch come inerti e senza quel vincolo leggerebbe 100% su memoria
vuota.

Tre definizioni, ognuna sbagliata in un modo diverso:

| Definizione | Errore |
|---|---|
| `derived / stored` | gli inerti contavano come derivati → 98.9% su memoria vuota |
| `(stored − pending − inert) / stored` | puniva lo scarto corretto → 18.9% senza nulla in sospeso |
| `derived / (derived + pending)` | l'inerte non era un candidato: non aiuta e non penalizza |

Con questa, la stessa sessione legge **99.8% di riduzione effettiva**: 205.001 token di storia grezza
contro 432 token di contesto attivo. **K1 (target >70%) è centrato su dati reali**, con una
definizione che resiste all'autocompiacimento.

## 61.25 §18 / §42 — la provenienza va verificata, non asserita

Primo dogfooding reale: hook installati nel repo di contextd e sessione viva. Il worker ha
registrato un obiettivo — *"eseguire un test reale usando un modello locale (qwen2.5:7b)"* — come
`source: user`, `critical`, confidenza 1.00. L'utente aveva chiesto un test reale; **il modello
locale era una proposta dell'agent.** E `user` + `critical` è la coppia che `isProtected` rende
permanente: da quel momento nulla poteva più rimuoverla.

È un fallimento diverso da quello dello scaffolding: niente è stato ingerito male, è il modello che
ha *asserito* una provenienza che non poteva vantare.

Regola da recepire in §18: **un worker può attribuire qualcosa all'utente solo citando come
`evidence` un evento `USER_MESSAGE` reale.** Le affermazioni non sostenute mantengono il testo e
perdono l'attribuzione — tornando così anche sotto il tetto di confidenza inferita. §42 chiede di
poter rispondere a "perché questa informazione è qui": se la risposta è una provenienza inventata,
la domanda non ha valore.

La regola non è un divieto: al run successivo tre `goals` sono tornati `source: user` + `critical` e
sono passati tutti e tre, perché citano i messaggi in cui quelle cose sono state dette davvero.

## 61.26 §11 — un errore appartiene alla chiamata che lo ha prodotto

Un one-liner `node -e` di debug è fallito e il suo stack trace è diventato un `known_issue` del
progetto. Il filtro sui comandi di scratch non poteva vederlo: un errore di tool arriva come
`ERROR_DETECTED` con solo `tool_use_id` e l'output — **il comando sta sull'evento `TOOL_CALL`
gemello**. Il fold ora correla i due.

Da aggiungere allo schema eventi di §11: la correlazione chiamata→risultato non è un dettaglio di
implementazione, è ciò che rende attribuibile un errore. Senza, un one-liner fallito e una build
fallita sono lo stesso evento con testo diverso.

## 61.27 §19 — anche una misura non è memoria

§19 dice che il codice non va memorizzato: il repository è la source of truth. Vale identicamente
per i numeri. L'estrazione reale ha registrato come lavoro completato *"coverage = 93.2%,
effective_reduction = 93.2%"* e *"194-198 test"*: entrambi **già falsi nel momento in cui sono stati
scritti**, perché la definizione di coverage è cambiata altre due volte nella stessa sessione.

Un numero che si muove a ogni run è telemetria, non stato del progetto. Va registrato che la misura
esiste e dove vive (`contextd status`), mai il suo valore istantaneo.

## 61.28 §29 — una metrica che non può cambiare non è una metrica

`never_retrieved` è rimasto al 100% anche dopo query che restituivano gli item giusti. Il context
builder ricavava gli id di ciò che aveva servito **ri-analizzando con una regex il proprio testo
renderizzato** (`[mem_...]`). Quando i worker hanno iniziato ad assegnare id brevi come `d3` — perché
un'altra modifica al prompt glielo chiedeva — la regex ha smesso di matchare in silenzio, e la
metrica è diventata strutturalmente incapace di muoversi.

È la stessa forma del primissimo difetto di questa revisione ("eventi scartati" che non poteva mai
essere diverso da zero). Regola: **non ricostruire mai un dato strutturato ri-analizzando il proprio
output.** Le sezioni ora portano con sé gli `itemIds`, il che è anche più preciso — un item escluso
dal budget non viene accreditato come recuperato.

Dopo la correzione, due query sulla memoria reale: **never_retrieved 50.0%**. Prima lettura onesta
della metà retrieval.
