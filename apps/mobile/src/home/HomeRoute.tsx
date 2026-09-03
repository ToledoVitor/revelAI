import { ArrowRight, List } from "phosphor-react-native";
import { useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import heroImage from "../../assets/futsal-hero.png";
import { theme } from "../theme/tokens";

type InactiveDestination =
  | "analisar-treino"
  | "desafio-verificado"
  | "meus-treinos"
  | "ranking"
  | "treino-livre";

type Choice = Readonly<{
  accessibilityLabel?: string;
  destination: InactiveDestination;
  detail: string;
  kicker?: string;
  number: string;
  title: string;
}>;

const choices: readonly Choice[] = [
  {
    accessibilityLabel: "Treino livre — análise aproximada",
    destination: "treino-livre",
    detail:
      "Insights aproximados sobre seu desempenho para você evoluir no seu ritmo.",
    number: "01",
    title: "Treino livre — análise aproximada",
  },
  {
    destination: "desafio-verificado",
    detail:
      "Análise calibrada em condições padrão para ranking competitivo confiável.",
    kicker: "Competitivo · calibrado",
    number: "02",
    title: "Desafio verificado",
  },
];

function openUnavailable(destination: InactiveDestination) {
  router.push(`/indisponivel/${destination}`);
}

export function HomeRoute() {
  const [isNavigationOpen, setNavigationOpen] = useState(false);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        accessibilityLabel="Conteúdo inicial rolável"
        contentContainerStyle={styles.scrollContent}
        style={styles.screen}
      >
        <View style={styles.header}>
          <Text
            accessibilityLabel="RevelAI"
            accessibilityRole="header"
            style={styles.brand}
          >
            Revel<Text style={styles.brandAccent}>AI</Text>
          </Text>
          <Pressable
            accessibilityHint="Exibe Meus treinos, Ranking e futuros esportes."
            accessibilityLabel={
              isNavigationOpen ? "Fechar navegação" : "Abrir navegação"
            }
            accessibilityRole="button"
            accessibilityState={{ expanded: isNavigationOpen }}
            onPress={() => setNavigationOpen((open) => !open)}
            style={({ pressed }) => [
              styles.menuButton,
              pressed && styles.menuButtonPressed,
            ]}
          >
            <List color={theme.color.nearBlack} size={24} weight="bold" />
          </Pressable>
        </View>

        {isNavigationOpen ? (
          <View
            accessibilityLabel="Navegação principal"
            accessibilityRole="menu"
            style={styles.menu}
          >
            <Pressable
              accessibilityHint="Abre uma tela que explica que Meus treinos ainda não está ativo."
              accessibilityLabel="Meus treinos"
              accessibilityRole="button"
              onPress={() => openUnavailable("meus-treinos")}
              style={({ pressed }) => [
                styles.menuEntry,
                pressed && styles.menuEntryPressed,
              ]}
            >
              <Text style={styles.menuEntryText}>Meus treinos</Text>
            </Pressable>
            <Pressable
              accessibilityHint="Abre uma tela que explica que Ranking ainda não está ativo."
              accessibilityLabel="Ranking"
              accessibilityRole="button"
              onPress={() => openUnavailable("ranking")}
              style={({ pressed }) => [
                styles.menuEntry,
                pressed && styles.menuEntryPressed,
              ]}
            >
              <Text style={styles.menuEntryText}>Ranking</Text>
            </Pressable>
            <Pressable
              accessibilityHint="Em breve: novos esportes ainda não estão disponíveis."
              accessibilityLabel="Novos esportes"
              accessibilityRole="button"
              accessibilityState={{ disabled: true }}
              disabled
              style={styles.menuEntryDisabled}
            >
              <Text style={styles.menuEntryText}>Novos esportes</Text>
              <Text style={styles.comingSoon}>Em breve</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.hero}>
          <Image
            accessibilityLabel="Jogador de futsal treinando em quadra interna"
            accessible
            resizeMode="cover"
            source={heroImage}
            style={styles.heroImage}
          />
          <View style={styles.heroCopy}>
            <Text accessibilityRole="header" style={styles.heading}>
              Treine.{"\n"}Grave.{"\n"}Evolua.
            </Text>
            <View accessible={false} style={styles.headingRule} />
            <Text style={styles.description}>
              Análises de visão computacional para jogadores de futsal que
              querem mais.
            </Text>
          </View>
        </View>

        <View style={styles.choices}>
          <Text style={styles.choicesHeading}>
            Escolha como você vai começar
          </Text>
          <View style={styles.choiceList}>
            {choices.map((choice) => (
              <Pressable
                accessibilityHint={`Abre uma tela que explica que ${choice.title} ainda não está ativo.`}
                accessibilityLabel={choice.accessibilityLabel ?? choice.title}
                accessibilityRole="button"
                key={choice.destination}
                onPress={() => openUnavailable(choice.destination)}
                style={({ pressed }) => [
                  styles.choice,
                  pressed && styles.choicePressed,
                ]}
              >
                <Text style={styles.choiceNumber}>{choice.number}</Text>
                <View style={styles.choiceContent}>
                  <Text style={styles.choiceTitle}>{choice.title}</Text>
                  {choice.kicker ? (
                    <Text style={styles.choiceKicker}>{choice.kicker}</Text>
                  ) : null}
                  <Text style={styles.choiceDetail}>{choice.detail}</Text>
                </View>
                <ArrowRight
                  color={theme.color.deepEmerald}
                  size={28}
                  weight="light"
                />
              </Pressable>
            ))}
          </View>
          <Pressable
            accessibilityHint="Abre uma tela que explica que a análise ainda não está ativa."
            accessibilityLabel="Analisar treino"
            accessibilityRole="button"
            onPress={() => openUnavailable("analisar-treino")}
            style={({ pressed }) => [
              styles.analyseButton,
              pressed && styles.analyseButtonPressed,
            ]}
          >
            <Text style={styles.analyseButtonText}>Analisar treino</Text>
            <ArrowRight
              color={theme.color.warmWhite}
              size={28}
              weight="light"
            />
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  analyseButton: {
    alignItems: "center",
    backgroundColor: theme.color.deepEmerald,
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 16,
    minHeight: 56,
    paddingHorizontal: 22,
  },
  analyseButtonPressed: {
    backgroundColor: "#005330",
  },
  analyseButtonText: {
    color: theme.color.warmWhite,
    fontFamily: theme.font.display,
    fontSize: 19,
    letterSpacing: 3.4,
    marginRight: 42,
    textTransform: "uppercase",
  },
  brand: {
    color: theme.color.nearBlack,
    fontFamily: theme.font.body,
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -2.8,
  },
  brandAccent: {
    color: theme.color.deepEmerald,
  },
  choice: {
    alignItems: "center",
    borderBottomColor: theme.color.borderGray,
    borderBottomWidth: theme.spacing.rule,
    flexDirection: "row",
    minHeight: 108,
    paddingVertical: 7,
  },
  choiceContent: {
    flex: 1,
    gap: 2,
    paddingHorizontal: 18,
  },
  choiceDetail: {
    color: theme.color.nearBlack,
    fontFamily: theme.font.body,
    fontSize: 13,
    lineHeight: 18,
  },
  choiceKicker: {
    color: theme.color.deepEmerald,
    fontFamily: theme.font.body,
    fontSize: 13,
    lineHeight: 16,
  },
  choiceList: {
    borderTopColor: theme.color.borderGray,
    borderTopWidth: theme.spacing.rule,
  },
  choiceNumber: {
    borderRightColor: theme.color.borderGray,
    borderRightWidth: theme.spacing.rule,
    color: theme.color.deepEmerald,
    fontFamily: theme.font.display,
    fontSize: 42,
    lineHeight: 42,
    paddingRight: 14,
    textAlign: "right",
    width: 74,
  },
  choicePressed: {
    backgroundColor: "#E0ECE5",
  },
  choiceTitle: {
    color: theme.color.nearBlack,
    fontFamily: theme.font.body,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 24,
  },
  choices: {
    paddingBottom: 18,
    paddingHorizontal: theme.spacing.edge,
  },
  choicesHeading: {
    color: theme.color.deepEmerald,
    fontFamily: theme.font.display,
    fontSize: 22,
    letterSpacing: 2.4,
    lineHeight: 24,
    marginBottom: 12,
    maxWidth: 245,
    textTransform: "uppercase",
  },
  comingSoon: {
    color: theme.color.mutedGray,
    fontFamily: theme.font.body,
    fontSize: 14,
    fontWeight: "700",
  },
  description: {
    color: theme.color.nearBlack,
    fontFamily: theme.font.body,
    fontSize: 20,
    lineHeight: 27,
    marginTop: 16,
    maxWidth: 205,
  },
  header: {
    alignItems: "center",
    borderBottomColor: "#30312D",
    borderBottomWidth: theme.spacing.rule,
    flexDirection: "row",
    justifyContent: "space-between",
    marginHorizontal: theme.spacing.edge,
    minHeight: 72,
  },
  heading: {
    color: theme.color.nearBlack,
    fontFamily: theme.font.display,
    fontSize: 102,
    lineHeight: 88,
    maxWidth: 214,
    textTransform: "uppercase",
  },
  headingRule: {
    backgroundColor: theme.color.deepEmerald,
    height: 3,
    marginTop: 19,
    width: 32,
  },
  hero: {
    height: 442,
    overflow: "hidden",
    position: "relative",
  },
  heroCopy: {
    left: theme.spacing.edge,
    position: "absolute",
    top: 42,
  },
  heroImage: {
    height: "100%",
    position: "absolute",
    right: 0,
    top: 0,
    width: "100%",
  },
  menu: {
    backgroundColor: theme.color.warmWhite,
    borderBottomColor: theme.color.borderGray,
    borderBottomWidth: theme.spacing.rule,
    gap: 2,
    paddingHorizontal: theme.spacing.edge,
    paddingVertical: 10,
  },
  menuButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: theme.spacing.touchTarget,
    minWidth: theme.spacing.touchTarget,
  },
  menuButtonPressed: {
    backgroundColor: "#E0ECE5",
  },
  menuEntry: {
    justifyContent: "center",
    minHeight: theme.spacing.touchTarget,
  },
  menuEntryDisabled: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: theme.spacing.touchTarget,
    opacity: 0.7,
  },
  menuEntryPressed: {
    backgroundColor: "#E0ECE5",
  },
  menuEntryText: {
    color: theme.color.nearBlack,
    fontFamily: theme.font.body,
    fontSize: 16,
    fontWeight: "700",
  },
  safeArea: {
    backgroundColor: theme.color.warmWhite,
    flex: 1,
  },
  screen: {
    backgroundColor: theme.color.warmWhite,
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
});
