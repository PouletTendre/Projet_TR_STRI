# Répartition hybride REST et JMS entre les composants de l'ICP et de la Messagerie

Le système combine des requêtes de consultation ou de demande initiées par des ressources clientes (création de certificat, révocation, contrôle de validité, récupération de clés publiques) avec des traitements internes d'autorité de certification, de diffusion d'événements d'invalidation et d'échange de messages de chat. Nous adoptons une architecture hybride combinant **REST (HTTP/JSON documenté en OpenAPI)** pour les façades synchrones orientées ressources (**AE**, **AV**, **Service de Publication**) et **JMS (Files et Sujets)** pour le couplage asynchrone entre **AE et AC**, la diffusion des publications (**Certificats et LCR**) vers le **Service de Publication** et les **AV**, ainsi que le transport de la **Messagerie Texte**.

## Considered Options

- **Tout-REST (HTTP synchrone de bout en bout)** : oblige les AC à être directement exposées en HTTP, impose du polling coûteux aux AV pour détecter les nouvelles LCR et s'adapte mal au caractère conversationnel et asynchrone de la messagerie (« chat »).
- **Tout-JMS (MOM de bout en bout)** : alourdit inutilement les opérations purement requête/réponse sans état comme la vérification ponctuelle d'un certificat auprès d'une AV ou la consultation d'un certificat public dans l'annuaire par des ressources hétérogènes (routeurs, clients légers).
- **Architecture hybride REST + JMS** : exploite chaque paradigme là où sa sémantique native excelle.

## Consequences

- Les **AC** restent isolées dans le réseau interne derrière des files JMS (`queue.pki.ac.<id_ac>.demandes`) sans exposition HTTP directe aux ressources finales.
- Les **AV** et le **Service de Publication** reçoivent en temps réel les émissions et révocations/suspensions via des sujets JMS (`topic.pki.publications.certificats` et `topic.pki.publications.lcr`), éliminant toute fenêtre d'incohérence lors des contrôles de validité.
- Les **AE** assurent la passerelle entre l'appel REST du Porteur et l'échange JMS avec l'AC via le patron *JMS Request-Reply* (`JMSCorrelationID` / `JMSReplyTo`).
