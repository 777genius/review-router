export interface GitHubTokenProvider {
  getToken(): Promise<string>;
  refreshToken(): Promise<string>;
}
