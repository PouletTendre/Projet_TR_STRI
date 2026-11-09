# Infrastructure à Clés Publiques et Messagerie Sécurisée

Système d'infrastructure à clés publiques (ICP) hiérarchique déployé au sein d'un domaine de confiance organisationnel unique, supportant une application de messagerie texte à sécurité modulable.

## Infrastructure à Clés Publiques (ICP)

**Domaine de confiance**:
Périmètre organisationnel unique gouverné par une même Autorité de Certification Racine dans lequel les identités et les numéros de série des certificats sont uniques.
_Avoid_: Réseau, tenant, royaume

**Ressource**:
Entité humaine, matérielle (ex. routeur) ou logicielle (ex. client de messagerie) appartenant à l'organisation et susceptible d'interagir avec l'ICP selon sa nature.
_Avoid_: Objet, nœud, équipement

**Porteur**:
Ressource titulaire d'un certificat et seule détentrice de la clé privée associée à la clé publique mentionnée dans ce certificat, lui permettant de signer ou de déchiffrer des documents.
_Avoid_: Propriétaire, détenteur, abonné

**Sujet**:
Identité du Porteur telle qu'elle est inscrite et certifiée au sein d'un Certificat.
_Avoid_: Titulaire, nom d'utilisateur

**Utilisateur ICP**:
Entité qui exploite le Certificat d'un Porteur pour vérifier une signature numérique ou chiffrer un contenu à destination de ce Porteur, après validation de la certification auprès d'une autorité de confiance.
_Avoid_: Consommateur, client PKI, vérificateur

**Biclé**:
Paire asymétrique indissociable composée d'une clé privée (gardée secrète par le Porteur) et d'une clé publique (diffusée via un Certificat), soumise à une politique d'usage explicite.
_Avoid_: Paire de clés, clés cryptographiques

**Certificat**:
Document numérique signé par une Autorité de Certification liant l'identité d'un Sujet à sa clé publique, et mentionnant un numéro de série unique, l'identifiant de l'AC émettrice, une période de validité et un usage autorisé.
_Avoid_: Jeton, accréditation, clé signée

**Autorité de Certification (AC)**:
Entité de confiance habilitée à émettre, signer et révoquer des certificats pour des Porteurs ou pour des AC subordonnées au sein de la hiérarchie organisationnelle.
_Avoid_: Tiers de confiance, serveur de clés

**AC Racine**:
Autorité de Certification de niveau 1 située au sommet de la hiérarchie, implicitement digne de confiance et dont le certificat est auto-signé.
_Avoid_: AC maîtresse, autorité principale

**AC Fille**:
Autorité de Certification intermédiaire (niveau 2 de direction ou niveau 3 de service) dont le certificat est émis et signé par une AC de niveau supérieur.
_Avoid_: Sous-AC, AC secondaire

**Chemin de certification**:
Chaîne ordonnée de certificats partant du certificat d'un Porteur et remontant à travers les AC Filles signataires successives jusqu'à l'AC Racine.
_Avoid_: Chaîne de confiance, arbre de certificats

**Autorité d'Enregistrement (AE)**:
Entité spécialisée par nature de Ressource qui authentifie les demandeurs, vérifie leurs droits (signature, chiffrement, révocation) et relaie leurs demandes de certification ou de révocation auprès de l'AC compétente.
_Avoid_: Guichet, service d'authentification

**Autorité de Validation (AV)**:
Entité spécialisée par nature de Ressource qui renseigne les Utilisateurs ICP sur le statut courant d'un certificat (`VALIDE`, `SUSPENDU`, `REVOQUE`, `INCONNU`) et sa conformité.
_Avoid_: Vérificateur de statut, serveur OCSP

**Service de Publication**:
Référentiel du domaine de confiance rendant accessibles les certificats émis ainsi que les Listes de Certificats Révoqués publiées par les Autorités de Certification.
_Avoid_: Base de données PKI, dépôt

**Liste des Certificats Révoqués (LCR)**:
Registre publié sous l'autorité d'une AC recensant les certificats invalidés avant leur date de fin de validité, que ce soit à titre définitif (Révocation) ou temporaire (Suspension).
_Avoid_: Liste noire, blocage

**Révocation**:
Invalidation définitive et irréversible d'un Certificat avant l'échéance de sa période de validité.
_Avoid_: Annulation, suppression

**Suspension**:
Invalidation temporaire et réversible d'un Certificat avant l'échéance de sa période de validité.
_Avoid_: Désactivation, mise en pause

## Messagerie Sécurisée

**Correspondant**:
Ressource participant à un Échange de messagerie texte, agissant à la fois comme Porteur (pour signer ses envois ou déchiffrer ses réceptions) et comme Utilisateur ICP (pour vérifier la signature ou chiffrer vers son interlocuteur).
_Avoid_: Interlocuteur, chatter, destinataire

**Échange**:
Session conversationnelle de messagerie texte entre deux Correspondants, dont le Niveau de sécurité est fixé dès le premier message et maintenu jusqu'au message de clôture `FIN_MSG`.
_Avoid_: Conversation, fil de discussion, salon

**Niveau de sécurité**:
Modalité cryptographique immuable appliquée à tous les messages d'un Échange, choisie par l'initiateur parmi quatre valeurs : `NON_SECURISE`, `SIGNE`, `CHIFFRE`, ou `SIGNE_ET_CHIFFRE`.
_Avoid_: Mode de chiffrement, politique de chat

**Message**:
Unité textuelle transmise entre deux Correspondants au cours d'un Échange selon le Niveau de sécurité établi, ou contenant le code `FIN_MSG` pour mettre fin à l'Échange.
_Avoid_: Paquet, courrier, trame
