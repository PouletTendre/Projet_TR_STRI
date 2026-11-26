# Spécification — Refonte complète ICP hiérarchique & Messagerie Sécurisée sous AMQP 0-9-1 et PlantUML

## Problem Statement

Le cahier des charges **M2 STRI 2026–2027** (*Infrastructure à Clés Publiques et Messagerie Sécurisée*) requiert une architecture distribuée permettant à une organisation, au sein d'un unique **Domaine de confiance**, de répondre avec certitude aux deux questions fondamentales préalables à tout usage d'une clé publique — *« À qui appartient cette clé publique ? »* et *« À quoi sert cette clé publique ? »* — tout en sécurisant une messagerie texte de type « chat » :

1. **Basculer l'intégralité de la conception, des contrats et du PoC exécutable vers AMQP 0-9-1** (clients producteurs/consommateurs, 3 échangeurs durables `direct`/`topic`, clés de routage, bindings et 5 files durables), en éliminant toute trace de l'ancien modèle.
2. **Modéliser tous les schémas en PlantUML**, en assurant une stricte neutralité technologique des diagrammes fonctionnels, d'architecture en grands blocs et de séquence (Sections 2–4), la topologie AMQP étant isolée en Section 6 et la vue Edge en blocs en Section 8.
3. **Produire un dossier de conception complet en 8 sections, une spécification OpenAPI 3.0.3 épurée et un PoC TypeScript autonome** sans dépendance d'exécution externe, vérifié par tests automatisés sur deux coutures principales et par un scénario CLI de démonstration bout-en-bout.

## Solution

L'architecture repose sur cinq piliers alignés sur le [glossaire du domaine](../GLOSSARY.md) :

1. **Architecture métier découplée et neutre vis-à-vis de la technologie** ([ADR 0002](./adr/0002-decouplage-ae-av-et-hierarchie-ac.md)) :
   - Hiérarchie d'**Autorités de Certification (AC)** sur 3 niveaux calquée sur l'organigramme : **AC Racine** (niveau 1, auto-signée) $\rightarrow$ **AC Filles** de Direction (niveau 2) $\rightarrow$ **AC Filles** de Service (niveau 3).
   - **Autorités d'Enregistrement (AE)** et **Autorités de Validation (AV)** mutualisées par nature de **Ressource** (`messagerie`, `routeurs`, `services`, `utilisateurs`), découplées de la topologie d'**AC**.
   - **Service de Publication** partagé à l'échelle du **Domaine de confiance**, diffusant les **Certificats**, **Chemins de certification** et **Listes des Certificats Révoqués (LCR)**.
   - Validation en **4 étapes** orchestrée côté **Utilisateur ICP**, l'**AV** étant strictement focalisée sur le statut courant (`VALIDE`, `SUSPENDU`, `REVOQUE`, `INCONNU`).
2. **Répartition hybride REST (OpenAPI 3.0.3) + AMQP 0-9-1** ([ADR 0001](./adr/0001-repartition-hybride-rest-amqp.md)) :
   - **REST** (`/api/v1`) pour les façades synchrones (`AE`, `AV`, `Service de Publication`).
   - **AMQP 0-9-1** avec 3 échangeurs durables : `ex.pki.commandes` (`direct`), `ex.pki.publications` (`topic`) et `ex.chat.messages` (`direct`), et 5 files durables (`q.pki.ac.<id_ac>.demandes`, `q.pki.ae.<id_ae>.reponses`, `q.pki.publication.flux`, `q.pki.av.<nature>.flux`, `q.chat.inbox.<id_correspondant>`).
3. **Messagerie Sécurisée à modalité immuable par Échange** :
   - Quatre **Niveaux de sécurité** (`NON_SECURISE`, `SIGNE`, `CHIFFRE`, `SIGNE_ET_CHIFFRE`) choisis au premier **Message** (`INIT_ECHANGE`), validés en 4 étapes, verrouillés pour tout l'**Échange** et clos par un **Message** contenant uniquement `FIN_MSG`.
4. **Couche de 4 micro-services « Edge »** :
   - `API Gateway`, `Service Discovery`, `Configuration Server` et `Passerelle Edge Messagerie` (cloisonnement ACL/vhost restreignant les **Correspondants** à `ex.chat.messages` et à leur propre file `q.chat.inbox.<id_correspondant>`).
5. **9 diagrammes PlantUML simples et PoC TypeScript autonome** :
   - Fichiers `.puml` autonomes sous `docs/diagrams/` embarqués caractère pour caractère dans [docs/dossier-conception.md](./dossier-conception.md), et courtier AMQP 0-9-1 simulé en mémoire sans Docker.

## Implementation Decisions

- **Modèle du Certificat** : 7 champs obligatoires du noyau (`numeroSerie`, `identifiantAcEmettrice`, `dateDebutValidite` / `dateFinValidite`, `usage`, `sujet`, `clePublique`, `signatureAc`) complétés par `niveauAcEmettrice`, `natureRessource` et `algorithmeSignature`.
- **Cycle de vie d'un Certificat** : `INCONNU → VALIDE` (émission), `VALIDE → SUSPENDU` (**Suspension**), `SUSPENDU → VALIDE` (**Réactivation**), `VALIDE | SUSPENDU → REVOQUE` (**Révocation**, état final irréversible ; rejet HTTP `409` en cas de transition interdite ou d'expiration).
- **Contrat REST ([openapi/pki-api.yaml](../openapi/pki-api.yaml))** : 11 opérations sous `/api/v1` (4 `AE`, 1 `AV` strictement limitée à `GET /av/{nature}/certificats/{numeroSerie}/statut`, 6 `Service de Publication`).
- **Catalogue de 9 messages AMQP JSON** : `DEMANDE_CERTIFICATION`, `REPONSE_CERTIFICATION`, `DEMANDE_REVOCATION`, `REPONSE_REVOCATION`, `PUBLICATION_CERTIFICAT`, `PUBLICATION_LCR`, `INIT_ECHANGE`, `MSG_TEXTE`, `FIN_MSG`.

## Testing Decisions

Les suites de tests automatisés vérifient uniquement les comportements observables aux frontières externes :
1. **Couture 1 — Façade REST Edge (`API Gateway`)** : amorçage hiérarchie 3 niveaux, enrôlement nominal et avec génération de **Biclé** côté **AC**, rejets `401`/`403`, routage AMQP `ex.pki.commandes` et corrélation `reply_to` / `correlation_id`, diffusion temps réel via `ex.pki.publications`, invalidations et conflits `409`, consultation annuaire et statut **AV**, protections Edge (TLS, limitation de débit `429`, cache `X-Cache`).
2. **Couture 2 — Façade Client `Utilisateur ICP` / `Correspondant`** : validation en 4 étapes (nominale et tous cas d'échec), cycle complet d'un **Échange** dans les 4 **Niveaux de sécurité** jusqu'à `FIN_MSG`, immuabilité du niveau, détection de révocation en cours d'**Échange**, et cloisonnement ACL strict de la `Passerelle Edge Messagerie`.
3. **Conformité documentaire** : validation structurelle OpenAPI 3.0.3, neutralité technologique des diagrammes 01–07, parité caractère pour caractère des 9 blocs PlantUML dans `docs/dossier-conception.md`, validité de tous les liens relatifs, et absence totale de reliquat hérité ou de bloc diagramme non-PlantUML dans tout le dépôt.

## Out of Scope

- Fédération inter-organisations hors de l'unique **Domaine de confiance**.
- Encodage binaire X.509 ASN.1 DER au-delà des 7 champs du noyau spécifiés.
- Salons multi-parties (un **Échange** oppose strictement deux **Correspondants**).
- Déploiement conteneurisé ou serveur réseau externe (PoC autonome en mémoire).
- Endpoint de validation tout-en-un côté **AV** (la responsabilité des 4 étapes reste chez l'**Utilisateur ICP**).
- Interface graphique de bureau ou web.
