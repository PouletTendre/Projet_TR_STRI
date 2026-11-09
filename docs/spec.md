## Problem Statement

Une organisation (entreprise, administration) souhaite mettre à disposition de ses **Ressources** (humaines, matérielles comme des routeurs, ou logicielles comme des clients de messagerie) une application de messagerie texte de type « chat » sécurisée au sein d'un unique **Domaine de confiance**.

Sans **Infrastructure à Clés Publiques (ICP)** structurée, un **Utilisateur ICP** ou un **Correspondant** ne peut pas répondre avec certitude aux deux questions fondamentales préalables à tout usage cryptographique d'une clé publique :
1. *« À qui appartient cette clé publique ? »* (authenticité du lien entre le **Sujet** et la **Biclé**, garantie par une chaîne de confiance remontant jusqu'à une **AC Racine**).
2. *« À quoi sert cette clé publique ? »* (conformité de l'opération souhaitée avec la politique d'`usage` autorisée par le **Certificat** et les droits accordés lors de l'enrôlement).

De plus, l'organisation est structurée hiérarchiquement en directions et services (exigeant une hiérarchie d'**Autorités de Certification** sur au moins trois niveaux) tout en gérant des **Ressources** de natures hétérogènes qui doivent s'adresser au plus bas niveau à des **Autorités d'Enregistrement (AE)** et des **Autorités de Validation (AV)** propres à leur nature, avec prise en charge de la **Révocation** définitive et de la **Suspension** temporaire via une **Liste des Certificats Révoqués (LCR)** diffusée sans latence.

## Solution

Concevoir et spécifier une architecture distribuée hybride (**REST/OpenAPI** et **MOM/JMS**) réunissant une **Infrastructure à Clés Publiques (ICP)** hiérarchique à 3 niveaux et une **Messagerie Sécurisée** au sein du **Domaine de confiance** de l'organisation :

1. **Hiérarchie d'Autorités de Certification (AC) à 3 niveaux** calquée sur l'organigramme :
   - Une **AC Racine** (Niveau 1) auto-signée, implicitement de confiance.
   - Des **AC Filles** de Direction (Niveau 2) certifiées par l'**AC Racine**.
   - Des **AC Filles** de Service (Niveau 3) certifiées par l'AC de leur Direction, chargées d'émettre et de révoquer les certificats des **Porteurs** finaux.
2. **Découplage des AE et AV par nature de Ressource** ([ADR 0002](./adr/0002-decouplage-ae-av-par-nature-et-ac-hierarchiques.md)) : chaque **Ressource** s'adresse à l'**AE** et à l'**AV** dédiées à sa nature (`messagerie`, `routeurs`, `services`, `utilisateurs`). L'**AE** authentifie le demandeur, contrôle ses droits (`droit_signature`, `droit_chiffrement`, `droit_de_demande_de_revocation`) et achemine la demande vers l'**AC Fille** de Niveau 3 de son unité organisationnelle.
3. **Répartition technologique hybride REST + JMS** ([ADR 0001](./adr/0001-repartition-hybride-rest-jms.md)) :
   - **REST (OpenAPI 3.0)** pour les interactions synchrones orientées ressources entre les clients et les **AE**, les **AV** et le **Service de Publication**.
   - **Files JMS (*Queues*)** pour le traitement asynchrone et isolé des demandes entre **AE** et **AC** ainsi que pour l'acheminement point-à-point des messages de chat entre **Correspondants**.
   - **Sujets JMS (*Topics*)** pour la diffusion temps réel des nouveaux **Certificats** et des mises à jour des **LCR** (**Révocation**, **Suspension**, réactivation) des **AC** vers le **Service de Publication** et toutes les **AV**.
4. **Messagerie Texte Sécurisée à modalité par Échange** : lors du premier **Message** d'un **Échange**, le **Correspondant** initiateur fixe le **Niveau de sécurité** (`NON_SECURISE`, `SIGNE`, `CHIFFRE`, `SIGNE_ET_CHIFFRE`). Ce niveau est validé vis-à-vis des **Certificats** des deux **Correspondants** (4 étapes de validation), maintenu tout au long de l'**Échange**, jusqu'à la clôture explicite par l'envoi du code `FIN_MSG`.
5. **Couche de micro-services « Edge »** : intégration d'une *API Gateway*, d'un *Service Discovery*, d'un *Configuration Server* et d'une *Messaging Edge Gateway* (WebSocket/STOMP $\leftrightarrow$ JMS) pour sécuriser, router et mettre à l'échelle le système réparti.

## User Stories

1. As an Administrateur PKI, I want to initialize the **AC Racine** (level 1) with a self-signed **Certificat** and `CERTIFICATION_AC` usage, so that the entire **Domaine de confiance** shares a single root anchor of trust.
2. As an Administrateur PKI, I want the **AC Racine** (level 1) to issue and sign **Certificats** for department-level **AC Filles** (level 2), so that each functional department of the organization has its own intermediate certification authority.
3. As an Administrateur PKI, I want each department-level **AC Fille** (level 2) to issue and sign **Certificats** for service-level **AC Filles** (level 3), so that certificate issuance can be delegated down to operational units across at least three hierarchy levels.
4. As an Administrateur PKI, I want to register **Ressource** entries in the appropriate nature-specific **Autorité d'Enregistrement (AE)** with `nom_entite`, `mot_de_passe`, `droit_signature`, `droit_chiffrement`, `droit_de_demande_de_revocation`, and target level-3 **AC**, so that enrollment and revocation rights are strictly enforced by resource nature.
5. As a **Porteur**, I want to generate my own **Biclé** locally and submit only my public key, identity, password, and desired `usage` to the **AE** matching my **Ressource** nature, so that my private key never leaves my local environment.
6. As a constrained **Porteur** (such as a hardware router or lightweight agent), I want to request that the **AC** generate the **Biclé** on my behalf during enrollment, so that I receive both my signed **Certificat** and my newly generated private key without local key-generation hardware, while ensuring neither the **AC** nor the **AE** retains the private key.
7. As an **Autorité d'Enregistrement (AE)**, I want to authenticate the requesting **Porteur** and verify that its requested `usage` (`SIGNATURE`, `CHIFFREMENT`, or `SIGNATURE_ET_CHIFFREMENT`) matches its granted `droit_signature` and `droit_chiffrement` attributes before forwarding the request to the **AC**, so that unauthorized certification requests are rejected immediately with `401` or `403`.
8. As an **Autorité d'Enregistrement (AE)**, I want to forward validated certification requests asynchronously over a JMS queue to the **Porteur**'s level-3 **AC Fille** and correlate the **AC**'s reply via `JMSCorrelationID`, so that the **AC** remains isolated from direct HTTP traffic while the **Porteur** receives its signed **Certificat**.
9. As an **Autorité de Certification (AC)**, I want to assign a globally unique serial number within the **Domaine de confiance**, set the validity period, sign the **Certificat**, store it in my valid certificates registry, and broadcast it on a JMS publication topic, so that the **Service de Publication** and all **AV** instances learn of the new **Certificat** immediately.
10. As a **Porteur**, I want to request the definitive **Révocation** of my **Certificat** prior to its expiration date through my nature-specific **AE**, so that a compromised private key or decommissioned **Ressource** can no longer be trusted.
11. As a **Porteur**, I want to request the temporary **Suspension** of my **Certificat** prior to its expiration date through my nature-specific **AE**, so that my **Certificat** is treated as invalid during a temporary leave or maintenance window without permanently destroying it.
12. As a **Porteur**, I want to request the reactivation of my previously suspended **Certificat** through my nature-specific **AE**, so that I can resume using my **Certificat** once the temporary suspension period ends.
13. As an **Autorité d'Enregistrement (AE)**, I want to verify that a **Porteur** requesting **Révocation**, **Suspension**, or reactivation is authenticated, owns the target **Certificat**, and holds `droit_de_demande_de_revocation = oui`, so that unauthorized actors cannot invalidate certificates.
14. As an **Autorité de Certification (AC)**, I want to reject any attempt to reactivate a definitively revoked **Certificat** or to revoke an already expired **Certificat**, so that the irreversibility of **Révocation** and lifecycle invariants are preserved.
15. As an **Autorité de Certification (AC)**, I want to update and sign my **Liste des Certificats Révoqués (LCR)** upon every **Révocation**, **Suspension**, or reactivation and broadcast the update on a JMS topic, so that the **Service de Publication** and all **AV** modules update their revocation state in real time.
16. As an **Utilisateur ICP**, I want to query the **Service de Publication** by **Sujet**, issuing **AC**, usage, or serial number, so that I can retrieve the public **Certificat** of any **Porteur** with whom I need to interact.
17. As an **Utilisateur ICP**, I want to retrieve the ordered **Chemin de certification** from a leaf **Certificat** up through intermediate **AC Filles** (level 3 and level 2) to the self-signed **AC Racine** (level 1) from the **Service de Publication**, so that I can verify the complete chain of trust.
18. As an **Utilisateur ICP**, I want to validate a **Certificat** in four mandatory steps—(1) validity period check, (2) cryptographic signature and **Chemin de certification** verification up to the **AC Racine**, (3) current status check (`VALIDE`, `SUSPENDU`, `REVOQUE`, `INCONNU`) with the nature-specific **AV**, and (4) `usage` policy verification—so that I never rely on an expired, forged, revoked, suspended, or misused **Certificat**.
19. As a lightweight **Utilisateur ICP**, I want to delegate the full 4-step validation of a **Certificat** (including intermediate **AC** revocation checks along the **Chemin de certification**) to a single endpoint on my nature-specific **AV**, so that I can obtain a complete, authoritative validation verdict in one request.
20. As a **Correspondant** initiating a text messaging **Échange**, I want to select the **Niveau de sécurité** (`NON_SECURISE`, `SIGNE`, `CHIFFRE`, or `SIGNE_ET_CHIFFRE`) when preparing the first **Message**, so that the security modality of the conversation matches its sensitivity.
21. As an initiating **Correspondant** choosing `SIGNE`, `CHIFFRE`, or `SIGNE_ET_CHIFFRE`, I want my client to validate my interlocutor's **Certificat** (and my own **Certificat**'s `usage` rights) via the **AV** before transmitting the first **Message**, so that the **Échange** is blocked immediately if either **Certificat** is invalid or lacks the required `SIGNATURE` / `CHIFFREMENT` usage.
22. As a receiving **Correspondant**, I want my client to validate the sender's **Certificat** upon receiving the `INIT_ECHANGE` **Message** and lock in the **Niveau de sécurité** for that `echange_id`, so that all subsequent messages in the **Échange** enforce the exact same security modality.
23. As a **Correspondant** participating in an active **Échange**, I want any incoming or outgoing **Message** that deviates from the **Niveau de sécurité** established by the first **Message** to be rejected, so that a downgrade attack mid-conversation is impossible.
24. As a **Correspondant** in a `SIGNE` or `SIGNE_ET_CHIFFRE` **Échange**, I want every **Message** to be digitally signed with the sender's private key and verified with the sender's validated public key, so that message integrity, authentication, and non-repudiation are guaranteed.
25. As a **Correspondant** in a `CHIFFRE` or `SIGNE_ET_CHIFFRE` **Échange**, I want every **Message** payload to be encrypted using the recipient's validated public key and decrypted solely by the recipient's private key, so that confidentiality is guaranteed across the messaging transport.
26. As a **Correspondant**, I want to end an active **Échange** at any time by sending a **Message** containing solely the code `FIN_MSG` (protected according to the **Échange**'s **Niveau de sécurité**), so that both **Correspondants** cleanly close the chat session and reject any further messages under that `echange_id`.
27. As an operations engineer, I want all external REST traffic to pass through an Edge **API Gateway** coupled with **Service Discovery** and a **Configuration Server**, and all client chat traffic to pass through a **Messaging Edge Gateway**, so that internal **AC** nodes and the internal JMS broker are never directly exposed to end-user networks.

## Implementation Decisions

- **3-Level Hierarchical AC Topology Decoupled from Resource-Nature AE/AV Modules** ([ADR 0002](./adr/0002-decouplage-ae-av-par-nature-et-ac-hierarchiques.md)):
  - The certification hierarchy comprises at least 3 levels: Level 1 (**AC Racine**, self-signed), Level 2 (Department **AC Filles**, signed by Level 1), and Level 3 (Service **AC Filles**, signed by Level 2).
  - Intermediate **AC** certificates (Level 1 $\rightarrow$ Level 2 and Level 2 $\rightarrow$ Level 3) are provisioned through direct administrative certification between parent and child **AC** modules, without routing through an **AE**.
  - **AE** and **AV** modules are partitioned by **Ressource** nature (`messagerie`, `routeurs`, `services`, `utilisateurs`). When a **Porteur** contacts the **AE** of its nature, the **AE** authenticates the entity, checks its boolean rights, resolves its `acRattachementId` (Level 3 **AC**), and routes the request to that **AC**'s JMS queue.

- **Hybrid REST (OpenAPI) and JMS Communication Architecture** ([ADR 0001](./adr/0001-repartition-hybride-rest-jms.md)):
  - **REST over HTTPS (OpenAPI 3.0.3)** is used for synchronous, resource-oriented operations exposed via the **API Gateway**:
    - **AE** interface (`/ae/{nature}/demandes-certification`, `/ae/{nature}/demandes-revocation`, `/ae/{nature}/entites/{nomEntite}/droits`).
    - **AV** interface (`/av/{nature}/certificats/{numeroSerie}/statut` for unit status checks, and `/av/{nature}/validations` for full 4-step validation).
    - **Service de Publication** interface (`/annuaire/certificats`, `/annuaire/certificats/{numeroSerie}`, `/annuaire/certificats/{numeroSerie}/chemin-certification`, `/annuaire/autorites`, `/annuaire/autorites/{acId}/lcr`, `/annuaire/lcr`).
  - **JMS Point-to-Point Queues** are used for:
    - Asynchronous **AE $\leftrightarrow$ AC** command/reply processing (`queue.pki.ac.<id_ac>.demandes` and `queue.pki.ae.<id_ae>.reponses`), correlated via `JMSCorrelationID` and `JMSReplyTo`.
    - Asynchronous **Correspondant $\leftrightarrow$ Correspondant** chat delivery (`queue.chat.inbox.<id_correspondant>`).
  - **JMS Pub/Sub Topics** with durable subscriptions are used for:
    - Real-time broadcast of newly issued **Certificats** (`topic.pki.publications.certificats`) from any **AC** (Levels 1, 2, 3) to the **Service de Publication** and all **AV** modules.
    - Real-time broadcast of **LCR** updates (`topic.pki.publications.lcr`) upon **Révocation**, **Suspension**, or reactivation to the **Service de Publication** and all **AV** modules.

- **Certificate Lifecycle State Machine & LCR Semantics**:
  - A **Certificat** transitions across the following states (derived from the design specification):
```
[INCONNU] ──(Émission AC)──► [VALIDE]
[VALIDE]  ──(SUSPENSION)───► [SUSPENDU]
[SUSPENDU]──(REACTIVATION)─► [VALIDE]
[VALIDE]  ──(REVOCATION)───► [REVOQUE] (état final irréversible)
[SUSPENDU]──(REVOCATION)───► [REVOQUE] (état final irréversible)
```
  - Both `SUSPENDU` and `REVOQUE` entries appear in the issuing **AC**'s signed **LCR** and cause Step 3 of validation to fail (rejecting any cryptographic use of the **Certificat**).

- **4-Step Certificate Validation Contract**:
  - Every validation of a **Certificat** verifies:
    1. **Validity Period**: `dateDebutValidite <= currentTimestamp <= dateFinValidite` for every certificate in the **Chemin de certification**.
    2. **Signature & Certification Path**: cryptographic verification of each `signatureAc` from the leaf **Certificat** $\rightarrow$ Level 3 **AC Fille** $\rightarrow$ Level 2 **AC Fille** $\rightarrow$ Level 1 **AC Racine** (trusted anchor), plus verification that intermediate **AC** certificates carry `usage = CERTIFICATION_AC`.
    3. **Revocation/Suspension Status**: neither the leaf **Certificat** nor any intermediate **AC Fille** in the **Chemin de certification** has status `REVOQUE`, `SUSPENDU`, or `INCONNU` according to the **AV** / **LCR**.
    4. **Key Usage Policy**: the leaf **Certificat**'s `usage` (`SIGNATURE`, `CHIFFREMENT`, or `SIGNATURE_ET_CHIFFREMENT`) permits the requested operation.

- **Messaging Session (`Échange`) Protocol and Security Invariants**:
  - Every JMS chat message carries standardized headers (`JMSCorrelationID = echange_id`, `type_message` $\in$ `{INIT_ECHANGE, MSG_TEXTE, FIN_MSG}`, `niveau_securite` $\in$ `{NON_SECURISE, SIGNE, CHIFFRE, SIGNE_ET_CHIFFRE}`, `expediteur_id`, `destinataire_id`, `numero_serie_cert_expediteur`, `numero_sequence`).
  - Compatibility between the **Échange**'s `niveau_securite` and the **Correspondants**' **Certificats**:
    - `NON_SECURISE`: no **Certificat** required.
    - `SIGNE`: both **Correspondants** must hold a valid **Certificat** authorizing `SIGNATURE` (or `SIGNATURE_ET_CHIFFREMENT`).
    - `CHIFFRE`: both **Correspondants** must hold a valid **Certificat** authorizing `CHIFFREMENT` (or `SIGNATURE_ET_CHIFFREMENT`).
    - `SIGNE_ET_CHIFFRE`: both **Correspondants** must hold valid **Certificats** authorizing both signature and encryption (either via a combined `SIGNATURE_ET_CHIFFREMENT` certificate or distinct `SIGNATURE` and `CHIFFREMENT` certificates).
  - Sending a **Message** whose cleartext body is exclusively `FIN_MSG` transitions the **Échange** to a closed state on both ends.

- **Edge Microservices Layer**:
  - **API Gateway**: single North-South REST entry point routing `/ae/{nature}/...`, `/av/{nature}/...`, and `/annuaire/...`, enforcing TLS and rate-limiting.
  - **Service Discovery**: dynamic registry for **AE**, **AV**, and **Service de Publication** instances.
  - **Configuration Server**: centralized distribution of the 3-level **AC** hierarchy topology and the **AC Racine** trust anchor.
  - **Messaging Edge Gateway**: WebSocket/STOMP-to-JMS bridge isolating internal `queue.pki.*` and `topic.pki.*` destinations from user-facing networks and exposing only `queue.chat.inbox.<id_correspondant>`.

## Testing Decisions

- **What makes a good test**:
  - Tests must verify observable external behavior across module interfaces (HTTP status codes, response payloads conforming to the OpenAPI schemas, published JMS messages on target queues/topics, and end-to-end state transitions), never internal private helpers or storage details.
  - Tests should exercise the system through the **highest possible seams** (ideally two external seams covering the entire system):
    1. **The Edge PKI REST Seam** (`/ae/{nature}/...`, `/av/{nature}/...`, `/annuaire/...`), backed by an in-memory JMS broker adapter connecting the **AE**, the 3-level **AC** hierarchy, the **Service de Publication**, and the **AV** modules. A single test suite against this seam verifies enrollment, authentication/rights rejection, JMS request-reply correlation, 3-level **Chemin de certification** assembly, **Révocation**/**Suspension**/reactivation, real-time **LCR** propagation via JMS topics, and all 4 validation steps.
    2. **The Correspondant Messaging Session Seam**, backed by the in-memory JMS chat queues and the Edge PKI REST seam. Testing through this seam verifies opening an **Échange** under each of the four **Niveaux de sécurité**, pre-flight **AV** validation rejection when a peer's **Certificat** is revoked/suspended/expired or has an incompatible `usage`, mid-session security downgrade rejection, and clean session termination upon `FIN_MSG`.
- **Modules to be tested**:
  - **PKI Lifecycle & Validation Deep Module** (integrating **AE**, 3-level **AC**, **Service de Publication**, and **AV** behind the OpenAPI REST contract and JMS broker adapter).
  - **Secure Messaging Session Module** (integrating **Correspondant** cryptographic framing, **AV** pre-validation, and JMS inbox transport from `INIT_ECHANGE` to `FIN_MSG`).
  - **OpenAPI & Schema Contract Conformance** (validating the OpenAPI 3.0.3 specification and message payload schemas against all documented scenarios).
- **Prior art**:
  - Green-field repository containing the architectural design dossier (`docs/dossier-conception.md`), domain glossary (`GLOSSARY.md`), ADRs (`docs/adr/`), and OpenAPI 3.0.3 contract (`openapi/pki-api.yaml`).

## Out of Scope

- Cross-organization federation (bridge CAs or cross-certification outside the single organizational **Domaine de confiance**).
- X.509 ASN.1 DER binary encoding complexities beyond the 7 core certificate fields defined in the project specification.
- Multi-party group chat rooms (an **Échange** is strictly between two **Correspondants**).
- Graphical desktop or mobile user interface implementation (the messaging specification focuses on the distributed protocol, cryptographic modalities, and REST/JMS architecture).

## Further Notes

- Full UML diagrams (Use Case, Component, Deployment, and 5 Sequence Diagrams), complete JMS message payloads, and REST naming tables are maintained in `docs/dossier-conception.md`, with the formal OpenAPI 3.0.3 contract in `openapi/pki-api.yaml`.
