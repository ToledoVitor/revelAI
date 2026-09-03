import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { theme } from "../theme/tokens";

const destinationCopy: Readonly<Record<string, string>> = {
  "analisar-treino": "A análise de treino será disponibilizada em breve.",
  "desafio-verificado": "O desafio verificado será disponibilizado em breve.",
  "meus-treinos": "Meus treinos será disponibilizado em breve.",
  ranking: "Ranking será disponibilizado em breve.",
  "treino-livre": "O treino livre será disponibilizado em breve.",
};

type UnavailableScreenProps = Readonly<{
  destination: string;
}>;

export function UnavailableScreen({ destination }: UnavailableScreenProps) {
  const description =
    destinationCopy[destination] ??
    "Este recurso será disponibilizado em breve.";

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.heading}>
          Indisponível
        </Text>
        <Text accessibilityRole="alert" style={styles.status}>
          Disponível após ativação do fluxo
        </Text>
        <Text style={styles.description}>{description}</Text>
        <Pressable
          accessibilityHint="Retorna à página inicial."
          accessibilityLabel="Voltar ao início"
          accessibilityRole="button"
          onPress={() => router.replace("/")}
          style={({ pressed }) => [
            styles.action,
            pressed && styles.actionPressed,
          ]}
        >
          <Text style={styles.actionText}>Voltar ao início</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    borderColor: theme.color.deepEmerald,
    borderWidth: 1,
    justifyContent: "center",
    marginTop: 28,
    minHeight: theme.spacing.touchTarget,
    paddingHorizontal: 20,
  },
  actionPressed: {
    backgroundColor: "#E0ECE5",
  },
  actionText: {
    color: theme.color.deepEmerald,
    fontFamily: theme.font.display,
    fontSize: 18,
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  content: {
    gap: 12,
    maxWidth: 540,
    padding: theme.spacing.edge,
    width: "100%",
  },
  description: {
    color: theme.color.nearBlack,
    fontFamily: theme.font.body,
    fontSize: 17,
    lineHeight: 24,
  },
  heading: {
    color: theme.color.nearBlack,
    fontFamily: theme.font.display,
    fontSize: 54,
    lineHeight: 54,
    textTransform: "uppercase",
  },
  screen: {
    alignItems: "center",
    backgroundColor: theme.color.warmWhite,
    flex: 1,
    justifyContent: "center",
  },
  status: {
    color: theme.color.deepEmerald,
    fontFamily: theme.font.body,
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 22,
  },
});
