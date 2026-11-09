# Projet Traitements Répartis (M2 STRI) — Infrastructure à Clés Publiques & Messagerie Sécurisée

Conception d'une **Infrastructure à Clés Publiques (ICP / PKI)** hiérarchique à 3 niveaux et d'une application de **Messagerie Texte Sécurisée** (« chat ») déployées au sein d'un domaine de confiance organisationnel.

## Structure des livrables

| Fichier | Description |
| :--- | :--- |
| [docs/dossier-conception.md](./docs/dossier-conception.md) | **Dossier de conception complet** répondant aux spécifications du sujet : vue fonctionnelle (cas d'utilisation UML), architecture répartie (composants et déploiement UML), diagrammes de séquence UML, choix technologiques argumentés (REST vs JMS), architecture et messages JMS, schéma de nommage REST et micro-services « edge ». |
| [docs/spec.md](./docs/spec.md) | **Spécification produit & technique (`to-spec`)** : Problem Statement, Solution, 27 User Stories, Implementation Decisions, Testing Seams et Out of Scope. |
| [openapi/pki-api.yaml](./openapi/pki-api.yaml) | **Spécification standardisée OpenAPI 3.0.3** décrivant les ressources REST des Autorités d'Enregistrement (`/ae/{nature}/...`), des Autorités de Validation (`/av/{nature}/...`) et du Service de Publication / Annuaire (`/annuaire/...`). |
| [GLOSSARY.md](./GLOSSARY.md) | **Glossaire du domaine** formalisant les termes canoniques de l'ICP et de la Messagerie Sécurisée. |
| [docs/adr/0001-repartition-hybride-rest-jms.md](./docs/adr/0001-repartition-hybride-rest-jms.md) | **ADR 0001** — Répartition hybride REST (façades synchrones) et JMS (files AE↔AC, sujets de publication Certificats/LCR et messagerie). |
| [docs/adr/0002-decouplage-ae-av-par-nature-et-ac-hierarchiques.md](./docs/adr/0002-decouplage-ae-av-par-nature-et-ac-hierarchiques.md) | **ADR 0002** — Découplage entre les AE/AV spécialisées par nature de ressource et la hiérarchie d'AC à 3 niveaux calquée sur l'organisation. |
| [Projet_TR_STRI_2022_2023.pdf](./Projet_TR_STRI_2022_2023.pdf) | Cahier des charges original du projet (UPS / IRIT). |
