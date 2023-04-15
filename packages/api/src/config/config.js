export const buildGetConfig = ({ global }) => {
  return () => global.config;
};
