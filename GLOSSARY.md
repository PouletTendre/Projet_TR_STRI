# Infrastructure à Clés Publiques et Messagerie Sécurisée

Système d'infrastructure à clés publiques (ICP) hiérarchique déployé au sein d'un unique domaine de confiance organisationnel, sécurisant une messagerie texte de type « chat » entre ressources de l'organisation.

## Infrastructure à Clés Publiques (ICP)

**Domaine de confiance**:
Périmètre organisationnel unique gouverné par une même **AC Racine** dans lequel les identités des **Ressources** et les numéros de série des **Certificats** sont uniques.
_Avoid_: Réseau, tenant, royaume

**Ressource**:
Entité humaine, matérielle (ex. routeur) ou logicielle (ex. client de messagerie) appartenant à l'organisation et caractérisée par une nature qui détermine son **AE** et son **AV** de rattachement.
_Avoid_: Objet, nœud, équipement

**Porteur**:
**Ressource** titulaire d'un **Certificat** et seule détentrice de la clé privée associée à la clé publique mentionnée dans ce **Certificat**, lui permettant de signer ou de déchiffrer des documents.
_Avoid_: Propriétaire, détenteur, abonné

**Sujet**:
Identité d'un **Porteur** inscrite et attestée au sein d'un **Certificat**.
_Avoid_: Titulaire, identifiant de connexion

**Utilisateur ICP**:
Entité qui valide un **Certificat** à partir d'une **AC** digne de confiance (période de validité, signatures et **Chemin de certification**, statut auprès de l'**AV**, politique d'usage) afin de vérifier une signature ou de chiffrer un contenu à destination d'un **Porteur**.
_Avoid_: Consommateur, vérificateur, client PKI

**Biclé**:
Paire asymétrique indissociable composée d'une clé privée (gardée secrète par le **Porteur**) et d'une clé publique (publiée dans un **Certificat**), générée localement par le **Porteur** ou optionnellement par l'**AC** et restreinte à un usage explicite (`SIGNATURE`, `CHIFFREMENT`, `SIGNATURE_ET_CHIFFREMENT`, ou `CERTIFICATION_AC`).
_Avoid_: Paire de clés, clés cryptographiques

**Certificat**:
Document numérique signé par une **Autorité de Certification (AC)** liant un **Sujet** à une clé publique, et mentionnant un numéro de série unique dans le **Domaine de confiance**, l'identifiant de l'**AC** émettrice, une période de validité (deux dates), l'usage de la clé, le **Sujet**, la clé publique et la signature de l'**AC**.
_Avoid_: Jeton, accréditation, clé signée

**Autorité de Certification (AC)**:
Entité de confiance habilitée à émettre, signer et révoquer des **Certificats** pour des **Porteurs** ou des **AC Filles**, à maintenir sa **LCR** locale et, optionnellement, à créer des **Biclés**.
_Avoid_: Tiers de confiance, serveur de clés

**AC Racine**:
**Autorité de Certification (AC)** de niveau 1 au sommet de la hiérarchie organisationnelle, implicitement de confiance et dont le **Certificat** est auto-signé.
_Avoid_: AC maîtresse, autorité principale

**AC Fille**:
**Autorité de Certification (AC)** intermédiaire (niveau 2 de Direction ou niveau 3 de Service) dont le **Certificat** est émis et signé par son **AC** parente.
_Avoid_: Sous-AC, AC secondaire

**Chemin de certification**:
Chaîne ordonnée de **Certificats** remontant d'un **Certificat** de **Porteur** à travers ses **AC Filles** signataires successives jusqu'à l'**AC Racine**.
_Avoid_: Chaîne de confiance, arbre de certificats

**Autorité d'Enregistrement (AE)**:
Entité spécialisée par nature de **Ressource** qui authentifie les demandeurs (`nom_entité`, `mot_de_passe`), vérifie leurs droits (signature, chiffrement, demande de révocation) et relaie leurs demandes de certification ou d'invalidation à l'**AC** compétente.
_Avoid_: Guichet, service d'authentification

**Autorité de Validation (AV)**:
Entité spécialisée par nature de **Ressource** qui renseigne les **Utilisateurs ICP** sur le statut courant d'un **Certificat** (`VALIDE`, `SUSPENDU`, `REVOQUE` ou `INCONNU`).
_Avoid_: Vérificateur de statut, serveur OCSP

**Service de Publication**:
Référentiel partagé à l'échelle du **Domaine de confiance** rendant accessibles les **Certificats** émis (dont les **Chemins de certification**) ainsi que les **LCR** publiées par les **AC**.
_Avoid_: Base de données PKI, dépôt local

**Liste des Certificats Révoqués (LCR)**:
Registre maintenu et publié par une **AC** recensant les **Certificats** invalidés avant leur date de fin de validité, à titre définitif (**Révocation**) ou temporaire (**Suspension**).
_Avoid_: Liste noire, liste de blocage

**Révocation**:
Invalidation définitive et irréversible d'un **Certificat** avant sa date de fin de validité.
_Avoid_: Annulation, suppression

**Suspension**:
Invalidation temporaire et réversible d'un **Certificat** avant sa date de fin de validité, rendant son statut `SUSPENDU` jusqu'à une éventuelle **Réactivation** ou **Révocation**.
_Avoid_: Désactivation, mise en pause

**Réactivation**:
Levée d'une **Suspension** sur un **Certificat** non expiré, lui rendant le statut `VALIDE` (impossible pour un **Certificat** ayant fait l'objet d'une **Révocation**).
_Avoid_: Restauration, déblocage

## Messagerie Sécurisée

**Correspondant**:
**Ressource** participant à un **Échange**, agissant à la fois comme **Porteur** (signer ses envois, déchiffrer ses réceptions) et comme **Utilisateur ICP** (valider le **Certificat** de son interlocuteur, vérifier ses signatures, chiffrer à sa destination).
_Avoid_: Interlocuteur, chatter, destinataire

**Échange**:
Session de messagerie texte de type « chat » entre deux **Correspondants**, dont le **Niveau de sécurité** est choisi lors du premier **Message** et conservé jusqu'à réception d'un **Message** contenant uniquement le code `FIN_MSG`.
_Avoid_: Conversation, fil de discussion, salon

**Niveau de sécurité**:
Modalité cryptographique immuable d'un **Échange**, fixée par le **Correspondant** initiateur parmi `NON_SECURISE`, `SIGNE`, `CHIFFRE` ou `SIGNE_ET_CHIFFRE`.
_Avoid_: Mode de chiffrement, politique de chat

**Message**:
Unité textuelle échangée entre deux **Correspondants** au sein d'un **Échange** conformément à son **Niveau de sécurité**, ou contenant uniquement le code `FIN_MSG` pour clore l'**Échange**.
_Avoid_: Paquet, courrier, trame
