import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { colors } from '@/theme/tokens';

// Tiny text-glyph "icon" set — avoids the icon-font dep and gives us
// crisp rendering at every density. Swap for @expo/vector-icons later
// if we want filled SF Symbols.
function TabIcon({ char, focused }: { char: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 22, color: focused ? colors.accent : colors.textMuted }}>
      {char}
    </Text>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        tabBarStyle: {
          backgroundColor: colors.bgElevated,
          borderTopColor: colors.border,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Portfolio',
          tabBarIcon: ({ focused }) => <TabIcon char="◉" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="positions"
        options={{
          title: 'Positions',
          tabBarIcon: ({ focused }) => <TabIcon char="≡" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarIcon: ({ focused }) => <TabIcon char="↻" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ focused }) => <TabIcon char="⚙" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
