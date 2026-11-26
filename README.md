# Projet Traitements Répartis (M2 STRI 2026–2027) — Infrastructure à Clés Publiques & Messagerie Sécurisée

Conception et prototype exécutable autonome d'une **Infrastructure à Clés Publiques (ICP)** hiérarchique sur 3 niveaux et d'une application de **Messagerie Sécurisée** texte (« chat ») sous **REST (OpenAPI 3.0.3)**, **AMQP 0-9-1** et **PlantUML**, déployés au sein d'un unique **Domaine de confiance** organisationnel.

## Livrables documentaires et spécifications

| Livrable | Description |
| :--- | :--- |
| [Projet_TR_STRI_2026_2027.pdf](./Projet_TR_STRI_2026_2027.pdf) | Cahier des charges officiel M2 STRI 2026–2027 (UPS / IRIT — C. Teyssié, P. Torguet). |
| [docs/dossier-conception.md](./docs/dossier-conception.md) | **Dossier de conception complet en 8 sections** : contexte et modèle du noyau, vue fonctionnelle, architecture en blocs et hiérarchie d'AC sur 3 niveaux, 4 diagrammes de séquence, choix REST vs AMQP 0-9-1, architecture AMQP complète (3 échangeurs, 5 files, 9 messages JSON), ressources REST et micro-services « Edge ». |
| [openapi/pki-api.yaml](./openapi/pki-api.yaml) | **Spécification OpenAPI 3.0.3** des 11 opérations REST exposées derrière l'`API Gateway` sous `/api/v1` (`AE`, `AV` focalisée statut courant, `Service de Publication`). |
| [GLOSSARY.md](./GLOSSARY.md) | **Glossaire du domaine** définissant les termes canoniques de l'ICP et de la Messagerie Sécurisée. |
| [docs/adr/0001-repartition-hybride-rest-amqp.md](./docs/adr/0001-repartition-hybride-rest-amqp.md) | **ADR 0001** — Répartition hybride REST (façades clients synchrones) et AMQP 0-9-1 (`ex.pki.commandes`, `ex.pki.publications`, `ex.chat.messages`). |
| [docs/adr/0002-decouplage-ae-av-et-hierarchie-ac.md](./docs/adr/0002-decouplage-ae-av-et-hierarchie-ac.md) | **ADR 0002** — Découplage entre les AE/AV mutualisées par nature de Ressource et la hiérarchie d'AC à 3 niveaux calquée sur l'organisation. |
| [docs/spec.md](./docs/spec.md) | **Spécification de refonte (Spec #10)** : objectifs, User Stories, décisions d'architecture AMQP 0-9-1 / PlantUML et stratégie de test sur 2 coutures. |

### Diagrammes PlantUML autonomes (`docs/diagrams/`)

| Fichier | Vue modélisée |
| :--- | :--- |
| [docs/diagrams/01-cas-utilisation.puml](./docs/diagrams/01-cas-utilisation.puml) | Cas d'utilisation UML (4 acteurs, 7 cas majeurs, neutre vis-à-vis de la technologie). |
| [docs/diagrams/02-architecture-blocs.puml](./docs/diagrams/02-architecture-blocs.puml) | Architecture globale en 6 grands blocs métier (neutre vis-à-vis de la technologie). |
| [docs/diagrams/03-hierarchie-ac.puml](./docs/diagrams/03-hierarchie-ac.puml) | Hiérarchie d'Autorités de Certification sur 3 niveaux (`AC Racine` $\rightarrow$ `AC Fille` Direction $\rightarrow$ `AC Fille` Service $\rightarrow$ `Porteurs`). |
| [docs/diagrams/04-sequence-creation-certificat.puml](./docs/diagrams/04-sequence-creation-certificat.puml) | Séquence — Création de Certificat et enrôlement d'un Porteur. |
| [docs/diagrams/05-sequence-revocation-suspension.puml](./docs/diagrams/05-sequence-revocation-suspension.puml) | Séquence — Révocation, Suspension, Réactivation et diffusion de la LCR. |
| [docs/diagrams/06-sequence-validation-4-etapes.puml](./docs/diagrams/06-sequence-validation-4-etapes.puml) | Séquence — Validation de Certificat en 4 étapes orchestrée par l'Utilisateur ICP. |
| [docs/diagrams/07-sequence-messagerie-securisee.puml](./docs/diagrams/07-sequence-messagerie-securisee.puml) | Séquence — Messagerie texte sécurisée et clôture par `FIN_MSG`. |
| [docs/diagrams/08-architecture-amqp.puml](./docs/diagrams/08-architecture-amqp.puml) | Architecture AMQP 0-9-1 (3 échangeurs durables `direct`/`topic`, clés de routage, bindings et 5 files durables). |
| [docs/diagrams/09-microservices-edge.puml](./docs/diagrams/09-microservices-edge.puml) | Couche Micro-services « Edge » (`API Gateway`, `Passerelle Edge Messagerie`, `Service Discovery`, `Configuration Server`). |

## Exécution du PoC TypeScript autonome

Le PoC n'utilise aucune dépendance d'exécution externe (cryptographie RSA-2048 / SHA-256 / RSA-OAEP + AES-256-GCM via `node:crypto`, courtier AMQP 0-9-1 simulé en mémoire).

```bash
# Installer les dépendances de développement (TypeScript, Vitest)
npm ci

# Vérifier le typage strict TypeScript
npm run typecheck

# Exécuter l'ensemble des suites de tests automatisés (coutures REST/AMQP, messagerie, conformité)
npm test

# Exécuter le scénario CLI de démonstration bout-en-bout
npm run demo
```
